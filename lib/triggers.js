"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.addFunction = addFunction;
exports.addJob = addJob;
exports.addTrigger = addTrigger;
exports.addLiveQueryEventHandler = addLiveQueryEventHandler;
exports.removeFunction = removeFunction;
exports.removeTrigger = removeTrigger;
exports._unregisterAll = _unregisterAll;
exports.getTrigger = getTrigger;
exports.triggerExists = triggerExists;
exports.getFunction = getFunction;
exports.getFunctionNames = getFunctionNames;
exports.getJob = getJob;
exports.getJobs = getJobs;
exports.getValidator = getValidator;
exports.getRequestObject = getRequestObject;
exports.getRequestQueryObject = getRequestQueryObject;
exports.getResponseObject = getResponseObject;
exports.maybeRunAfterFindTrigger = maybeRunAfterFindTrigger;
exports.maybeRunQueryTrigger = maybeRunQueryTrigger;
exports.maybeRunTrigger = maybeRunTrigger;
exports.inflate = inflate;
exports.runLiveQueryEventHandlers = runLiveQueryEventHandlers;
exports.Types = void 0;

var _node = _interopRequireDefault(require("parse/node"));

var _logger = require("./logger");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// triggers.js
const AWSXRay = require('aws-xray-sdk');

const Types = {
  beforeLogin: 'beforeLogin',
  beforeSave: 'beforeSave',
  afterSave: 'afterSave',
  beforeDelete: 'beforeDelete',
  afterDelete: 'afterDelete',
  beforeFind: 'beforeFind',
  afterFind: 'afterFind'
};
exports.Types = Types;

const baseStore = function () {
  const Validators = {};
  const Functions = {};
  const Jobs = {};
  const LiveQuery = [];
  const Triggers = Object.keys(Types).reduce(function (base, key) {
    base[key] = {};
    return base;
  }, {});
  return Object.freeze({
    Functions,
    Jobs,
    Validators,
    Triggers,
    LiveQuery
  });
};

function validateClassNameForTriggers(className, type) {
  const restrictedClassNames = ['_Session'];

  if (restrictedClassNames.indexOf(className) != -1) {
    throw `Triggers are not supported for ${className} class.`;
  }

  if (type == Types.beforeSave && className === '_PushStatus') {
    // _PushStatus uses undocumented nested key increment ops
    // allowing beforeSave would mess up the objects big time
    // TODO: Allow proper documented way of using nested increment ops
    throw 'Only afterSave is allowed on _PushStatus';
  }

  if (type === Types.beforeLogin && className !== '_User') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _User class is allowed for the beforeLogin trigger';
  }

  return className;
}

const _triggerStore = {};
const Category = {
  Functions: 'Functions',
  Validators: 'Validators',
  Jobs: 'Jobs',
  Triggers: 'Triggers'
};

function getStore(category, name, applicationId) {
  const path = name.split('.');
  path.splice(-1); // remove last component

  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();
  let store = _triggerStore[applicationId][category];

  for (const component of path) {
    store = store[component];

    if (!store) {
      return undefined;
    }
  }

  return store;
}

function add(category, name, handler, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  store[lastComponent] = handler;
}

function remove(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  delete store[lastComponent];
}

function get(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  return store[lastComponent];
}

function addFunction(functionName, handler, validationHandler, applicationId) {
  add(Category.Functions, functionName, handler, applicationId);
  add(Category.Validators, functionName, validationHandler, applicationId);
}

function addJob(jobName, handler, applicationId) {
  add(Category.Jobs, jobName, handler, applicationId);
}

function addTrigger(type, className, handler, applicationId) {
  validateClassNameForTriggers(className, type);
  add(Category.Triggers, `${type}.${className}`, handler, applicationId);
}

function addLiveQueryEventHandler(handler, applicationId) {
  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();

  _triggerStore[applicationId].LiveQuery.push(handler);
}

function removeFunction(functionName, applicationId) {
  remove(Category.Functions, functionName, applicationId);
}

function removeTrigger(type, className, applicationId) {
  remove(Category.Triggers, `${type}.${className}`, applicationId);
}

function _unregisterAll() {
  Object.keys(_triggerStore).forEach(appId => delete _triggerStore[appId]);
}

function getTrigger(className, triggerType, applicationId) {
  if (!applicationId) {
    throw 'Missing ApplicationID';
  }

  return get(Category.Triggers, `${triggerType}.${className}`, applicationId);
}

function triggerExists(className, type, applicationId) {
  return getTrigger(className, type, applicationId) != undefined;
}

function getFunction(functionName, applicationId) {
  return get(Category.Functions, functionName, applicationId);
}

function getFunctionNames(applicationId) {
  const store = _triggerStore[applicationId] && _triggerStore[applicationId][Category.Functions] || {};
  const functionNames = [];

  const extractFunctionNames = (namespace, store) => {
    Object.keys(store).forEach(name => {
      const value = store[name];

      if (namespace) {
        name = `${namespace}.${name}`;
      }

      if (typeof value === 'function') {
        functionNames.push(name);
      } else {
        extractFunctionNames(name, value);
      }
    });
  };

  extractFunctionNames(null, store);
  return functionNames;
}

function getJob(jobName, applicationId) {
  return get(Category.Jobs, jobName, applicationId);
}

function getJobs(applicationId) {
  var manager = _triggerStore[applicationId];

  if (manager && manager.Jobs) {
    return manager.Jobs;
  }

  return undefined;
}

function getValidator(functionName, applicationId) {
  return get(Category.Validators, functionName, applicationId);
}

function getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context) {
  const request = {
    triggerName: triggerType,
    object: parseObject,
    master: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip
  };

  if (originalParseObject) {
    request.original = originalParseObject;
  }

  if (triggerType === Types.beforeSave || triggerType === Types.afterSave) {
    // Set a copy of the context on the request object.
    request.context = Object.assign({}, context);
  }

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
  }

  if (auth.user) {
    request['user'] = auth.user;
  }

  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }

  return request;
}

function getRequestQueryObject(triggerType, auth, query, count, config, isGet) {
  isGet = !!isGet;
  var request = {
    triggerName: triggerType,
    query,
    master: false,
    count,
    log: config.loggerController,
    isGet,
    headers: config.headers,
    ip: config.ip
  };

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
  }

  if (auth.user) {
    request['user'] = auth.user;
  }

  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }

  return request;
} // Creates the response object, and uses the request object to pass data
// The API will call this with REST API formatted objects, this will
// transform them to Parse.Object instances expected by Cloud Code.
// Any changes made to the object in a beforeSave will be included.


function getResponseObject(request, resolve, reject) {
  return {
    success: function (response) {
      if (request.triggerName === Types.afterFind) {
        if (!response) {
          response = request.objects;
        }

        response = response.map(object => {
          return object.toJSON();
        });
        return resolve(response);
      } // Use the JSON response


      if (response && typeof response === 'object' && !request.object.equals(response) && request.triggerName === Types.beforeSave) {
        return resolve(response);
      }

      if (response && typeof response === 'object' && request.triggerName === Types.afterSave) {
        return resolve(response);
      }

      if (request.triggerName === Types.afterSave) {
        return resolve();
      }

      response = {};

      if (request.triggerName === Types.beforeSave) {
        response['object'] = request.object._getSaveJSON();
      }

      return resolve(response);
    },
    error: function (error) {
      if (error instanceof _node.default.Error) {
        reject(error);
      } else if (error instanceof Error) {
        reject(new _node.default.Error(_node.default.Error.SCRIPT_FAILED, error.message));
      } else {
        reject(new _node.default.Error(_node.default.Error.SCRIPT_FAILED, error));
      }
    }
  };
}

function userIdForLog(auth) {
  return auth && auth.user ? auth.user.id : undefined;
}

function logTriggerAfterHook(triggerType, className, input, auth) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerSuccessBeforeHook(triggerType, className, input, result, auth) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  const cleanResult = _logger.logger.truncateLogMessage(JSON.stringify(result));

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Result: ${cleanResult}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerErrorBeforeHook(triggerType, className, input, auth, error) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  _logger.logger.error(`${triggerType} failed for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Error: ${JSON.stringify(error)}`, {
    className,
    triggerType,
    error,
    user: userIdForLog(auth)
  });
}

function maybeRunAfterFindTrigger(triggerType, auth, className, objects, config) {
  return new Promise((resolve, reject) => {
    const trigger = getTrigger(className, triggerType, config.applicationId);

    if (!trigger) {
      return resolve();
    }

    const request = getRequestObject(triggerType, auth, null, null, config);
    const {
      success,
      error
    } = getResponseObject(request, object => {
      resolve(object);
    }, error => {
      reject(error);
    });
    logTriggerSuccessBeforeHook(triggerType, className, 'AfterFind', JSON.stringify(objects), auth);
    request.objects = objects.map(object => {
      //setting the class name to transform into parse object
      object.className = className;
      return _node.default.Object.fromJSON(object);
    });
    return tracePromise(triggerType, className, Promise.resolve().then(() => {
      const response = trigger(request);

      if (response && typeof response.then === 'function') {
        return response.then(results => {
          if (!results) {
            throw new _node.default.Error(_node.default.Error.SCRIPT_FAILED, 'AfterFind expect results to be returned in the promise');
          }

          return results;
        });
      }

      return response;
    }).then(success, error));
  }).then(results => {
    logTriggerAfterHook(triggerType, className, JSON.stringify(results), auth);
    return results;
  });
}

function maybeRunQueryTrigger(triggerType, className, restWhere, restOptions, config, auth, isGet) {
  const trigger = getTrigger(className, triggerType, config.applicationId);

  if (!trigger) {
    return Promise.resolve({
      restWhere,
      restOptions
    });
  }

  const parseQuery = new _node.default.Query(className);

  if (restWhere) {
    parseQuery._where = restWhere;
  }

  let count = false;

  if (restOptions) {
    if (restOptions.include && restOptions.include.length > 0) {
      parseQuery._include = restOptions.include.split(',');
    }

    if (restOptions.skip) {
      parseQuery._skip = restOptions.skip;
    }

    if (restOptions.limit) {
      parseQuery._limit = restOptions.limit;
    }

    count = !!restOptions.count;
  }

  const requestObject = getRequestQueryObject(triggerType, auth, parseQuery, count, config, isGet);
  return tracePromise(triggerType, className, Promise.resolve().then(() => {
    return trigger(requestObject);
  }).then(result => {
    let queryResult = parseQuery;

    if (result && result instanceof _node.default.Query) {
      queryResult = result;
    }

    const jsonQuery = queryResult.toJSON();

    if (jsonQuery.where) {
      restWhere = jsonQuery.where;
    }

    if (jsonQuery.limit) {
      restOptions = restOptions || {};
      restOptions.limit = jsonQuery.limit;
    }

    if (jsonQuery.skip) {
      restOptions = restOptions || {};
      restOptions.skip = jsonQuery.skip;
    }

    if (jsonQuery.include) {
      restOptions = restOptions || {};
      restOptions.include = jsonQuery.include;
    }

    if (jsonQuery.keys) {
      restOptions = restOptions || {};
      restOptions.keys = jsonQuery.keys;
    }

    if (jsonQuery.order) {
      restOptions = restOptions || {};
      restOptions.order = jsonQuery.order;
    }

    if (requestObject.readPreference) {
      restOptions = restOptions || {};
      restOptions.readPreference = requestObject.readPreference;
    }

    if (requestObject.includeReadPreference) {
      restOptions = restOptions || {};
      restOptions.includeReadPreference = requestObject.includeReadPreference;
    }

    if (requestObject.subqueryReadPreference) {
      restOptions = restOptions || {};
      restOptions.subqueryReadPreference = requestObject.subqueryReadPreference;
    }

    return {
      restWhere,
      restOptions
    };
  }, err => {
    if (typeof err === 'string') {
      throw new _node.default.Error(1, err);
    } else {
      throw err;
    }
  }));
} // To be used as part of the promise chain when saving/deleting an object
// Will resolve successfully if no trigger is configured
// Resolves to an object, empty or containing an object key. A beforeSave
// trigger will set the object key to the rest format object to save.
// originalParseObject is optional, we only need that for before/afterSave functions


function maybeRunTrigger(triggerType, auth, parseObject, originalParseObject, config, context) {
  if (!parseObject) {
    return Promise.resolve({});
  }

  return new Promise(function (resolve, reject) {
    var trigger = getTrigger(parseObject.className, triggerType, config.applicationId);
    if (!trigger) return resolve();
    var request = getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context);
    var {
      success,
      error
    } = getResponseObject(request, object => {
      logTriggerSuccessBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), object, auth);

      if (triggerType === Types.beforeSave || triggerType === Types.afterSave) {
        Object.assign(context, request.context);
      }

      resolve(object);
    }, error => {
      logTriggerErrorBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), auth, error);
      reject(error);
    }); // AfterSave and afterDelete triggers can return a promise, which if they
    // do, needs to be resolved before this promise is resolved,
    // so trigger execution is synced with RestWrite.execute() call.
    // If triggers do not return a promise, they can run async code parallel
    // to the RestWrite.execute() call.

    return Promise.resolve().then(() => {
      const promise = trigger(request);

      if (triggerType === Types.afterSave || triggerType === Types.afterDelete) {
        logTriggerAfterHook(triggerType, parseObject.className, parseObject.toJSON(), auth);
      } // beforeSave is expected to return null (nothing)


      if (triggerType === Types.beforeSave) {
        if (promise && typeof promise.then === 'function') {
          return promise.then(response => {
            // response.object may come from express routing before hook
            if (response && response.object) {
              return response;
            }

            return null;
          });
        }

        return null;
      }

      return promise;
    }).then(success, error);
  });
} // Converts a REST-format object to a Parse.Object
// data is either className or an object


function inflate(data, restObject) {
  var copy = typeof data == 'object' ? data : {
    className: data
  };

  for (var key in restObject) {
    copy[key] = restObject[key];
  }

  return _node.default.Object.fromJSON(copy);
}

function runLiveQueryEventHandlers(data, applicationId = _node.default.applicationId) {
  if (!_triggerStore || !_triggerStore[applicationId] || !_triggerStore[applicationId].LiveQuery) {
    return;
  }

  _triggerStore[applicationId].LiveQuery.forEach(handler => handler(data));
}

function tracePromise(type, className, promise = Promise.resolve()) {
  const parent = AWSXRay.getSegment();

  if (!parent) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    AWSXRay.captureAsyncFunc(`Parse-Server_triggers_${type}_${className}`, subsegment => {
      subsegment && subsegment.addAnnotation('Controller', 'triggers');
      subsegment && subsegment.addAnnotation('Type', type);
      subsegment && subsegment.addAnnotation('ClassName', className);
      promise.then(function (result) {
        resolve(result);
        subsegment && subsegment.close();
      }, function (error) {
        reject(error);
        subsegment && subsegment.close(error);
      });
    });
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJuYW1lcyI6WyJBV1NYUmF5IiwicmVxdWlyZSIsIlR5cGVzIiwiYmVmb3JlTG9naW4iLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmFzZVN0b3JlIiwiVmFsaWRhdG9ycyIsIkZ1bmN0aW9ucyIsIkpvYnMiLCJMaXZlUXVlcnkiLCJUcmlnZ2VycyIsIk9iamVjdCIsImtleXMiLCJyZWR1Y2UiLCJiYXNlIiwia2V5IiwiZnJlZXplIiwidmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyIsImNsYXNzTmFtZSIsInR5cGUiLCJyZXN0cmljdGVkQ2xhc3NOYW1lcyIsImluZGV4T2YiLCJfdHJpZ2dlclN0b3JlIiwiQ2F0ZWdvcnkiLCJnZXRTdG9yZSIsImNhdGVnb3J5IiwibmFtZSIsImFwcGxpY2F0aW9uSWQiLCJwYXRoIiwic3BsaXQiLCJzcGxpY2UiLCJQYXJzZSIsInN0b3JlIiwiY29tcG9uZW50IiwidW5kZWZpbmVkIiwiYWRkIiwiaGFuZGxlciIsImxhc3RDb21wb25lbnQiLCJyZW1vdmUiLCJnZXQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRMaXZlUXVlcnlFdmVudEhhbmRsZXIiLCJwdXNoIiwicmVtb3ZlRnVuY3Rpb24iLCJyZW1vdmVUcmlnZ2VyIiwiX3VucmVnaXN0ZXJBbGwiLCJmb3JFYWNoIiwiYXBwSWQiLCJnZXRUcmlnZ2VyIiwidHJpZ2dlclR5cGUiLCJ0cmlnZ2VyRXhpc3RzIiwiZ2V0RnVuY3Rpb24iLCJnZXRGdW5jdGlvbk5hbWVzIiwiZnVuY3Rpb25OYW1lcyIsImV4dHJhY3RGdW5jdGlvbk5hbWVzIiwibmFtZXNwYWNlIiwidmFsdWUiLCJnZXRKb2IiLCJnZXRKb2JzIiwibWFuYWdlciIsImdldFZhbGlkYXRvciIsImdldFJlcXVlc3RPYmplY3QiLCJhdXRoIiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsInJlcXVlc3QiLCJ0cmlnZ2VyTmFtZSIsIm9iamVjdCIsIm1hc3RlciIsImxvZyIsImxvZ2dlckNvbnRyb2xsZXIiLCJoZWFkZXJzIiwiaXAiLCJvcmlnaW5hbCIsImFzc2lnbiIsImlzTWFzdGVyIiwidXNlciIsImluc3RhbGxhdGlvbklkIiwiZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0IiwicXVlcnkiLCJjb3VudCIsImlzR2V0IiwiZ2V0UmVzcG9uc2VPYmplY3QiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsInRvSlNPTiIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImVycm9yIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImlkIiwibG9nVHJpZ2dlckFmdGVySG9vayIsImlucHV0IiwiY2xlYW5JbnB1dCIsImxvZ2dlciIsInRydW5jYXRlTG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpbmZvIiwibG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rIiwicmVzdWx0IiwiY2xlYW5SZXN1bHQiLCJsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rIiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwiUHJvbWlzZSIsInRyaWdnZXIiLCJmcm9tSlNPTiIsInRyYWNlUHJvbWlzZSIsInRoZW4iLCJyZXN1bHRzIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsInBhcnNlUXVlcnkiLCJRdWVyeSIsIl93aGVyZSIsImluY2x1ZGUiLCJsZW5ndGgiLCJfaW5jbHVkZSIsInNraXAiLCJfc2tpcCIsImxpbWl0IiwiX2xpbWl0IiwicmVxdWVzdE9iamVjdCIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5Iiwid2hlcmUiLCJvcmRlciIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsImVyciIsIm1heWJlUnVuVHJpZ2dlciIsInByb21pc2UiLCJpbmZsYXRlIiwiZGF0YSIsInJlc3RPYmplY3QiLCJjb3B5IiwicnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyIsInBhcmVudCIsImdldFNlZ21lbnQiLCJjYXB0dXJlQXN5bmNGdW5jIiwic3Vic2VnbWVudCIsImFkZEFubm90YXRpb24iLCJjbG9zZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFHQTs7QUFDQTs7OztBQUpBO0FBQ0EsTUFBTUEsT0FBTyxHQUFHQyxPQUFPLENBQUMsY0FBRCxDQUF2Qjs7QUFLTyxNQUFNQyxLQUFLLEdBQUc7QUFDbkJDLEVBQUFBLFdBQVcsRUFBRSxhQURNO0FBRW5CQyxFQUFBQSxVQUFVLEVBQUUsWUFGTztBQUduQkMsRUFBQUEsU0FBUyxFQUFFLFdBSFE7QUFJbkJDLEVBQUFBLFlBQVksRUFBRSxjQUpLO0FBS25CQyxFQUFBQSxXQUFXLEVBQUUsYUFMTTtBQU1uQkMsRUFBQUEsVUFBVSxFQUFFLFlBTk87QUFPbkJDLEVBQUFBLFNBQVMsRUFBRTtBQVBRLENBQWQ7OztBQVVQLE1BQU1DLFNBQVMsR0FBRyxZQUFXO0FBQzNCLFFBQU1DLFVBQVUsR0FBRyxFQUFuQjtBQUNBLFFBQU1DLFNBQVMsR0FBRyxFQUFsQjtBQUNBLFFBQU1DLElBQUksR0FBRyxFQUFiO0FBQ0EsUUFBTUMsU0FBUyxHQUFHLEVBQWxCO0FBQ0EsUUFBTUMsUUFBUSxHQUFHQyxNQUFNLENBQUNDLElBQVAsQ0FBWWYsS0FBWixFQUFtQmdCLE1BQW5CLENBQTBCLFVBQVNDLElBQVQsRUFBZUMsR0FBZixFQUFvQjtBQUM3REQsSUFBQUEsSUFBSSxDQUFDQyxHQUFELENBQUosR0FBWSxFQUFaO0FBQ0EsV0FBT0QsSUFBUDtBQUNELEdBSGdCLEVBR2QsRUFIYyxDQUFqQjtBQUtBLFNBQU9ILE1BQU0sQ0FBQ0ssTUFBUCxDQUFjO0FBQ25CVCxJQUFBQSxTQURtQjtBQUVuQkMsSUFBQUEsSUFGbUI7QUFHbkJGLElBQUFBLFVBSG1CO0FBSW5CSSxJQUFBQSxRQUptQjtBQUtuQkQsSUFBQUE7QUFMbUIsR0FBZCxDQUFQO0FBT0QsQ0FqQkQ7O0FBbUJBLFNBQVNRLDRCQUFULENBQXNDQyxTQUF0QyxFQUFpREMsSUFBakQsRUFBdUQ7QUFDckQsUUFBTUMsb0JBQW9CLEdBQUcsQ0FBQyxVQUFELENBQTdCOztBQUNBLE1BQUlBLG9CQUFvQixDQUFDQyxPQUFyQixDQUE2QkgsU0FBN0IsS0FBMkMsQ0FBQyxDQUFoRCxFQUFtRDtBQUNqRCxVQUFPLGtDQUFpQ0EsU0FBVSxTQUFsRDtBQUNEOztBQUNELE1BQUlDLElBQUksSUFBSXRCLEtBQUssQ0FBQ0UsVUFBZCxJQUE0Qm1CLFNBQVMsS0FBSyxhQUE5QyxFQUE2RDtBQUMzRDtBQUNBO0FBQ0E7QUFDQSxVQUFNLDBDQUFOO0FBQ0Q7O0FBQ0QsTUFBSUMsSUFBSSxLQUFLdEIsS0FBSyxDQUFDQyxXQUFmLElBQThCb0IsU0FBUyxLQUFLLE9BQWhELEVBQXlEO0FBQ3ZEO0FBQ0E7QUFDQSxVQUFNLDZEQUFOO0FBQ0Q7O0FBQ0QsU0FBT0EsU0FBUDtBQUNEOztBQUVELE1BQU1JLGFBQWEsR0FBRyxFQUF0QjtBQUVBLE1BQU1DLFFBQVEsR0FBRztBQUNmaEIsRUFBQUEsU0FBUyxFQUFFLFdBREk7QUFFZkQsRUFBQUEsVUFBVSxFQUFFLFlBRkc7QUFHZkUsRUFBQUEsSUFBSSxFQUFFLE1BSFM7QUFJZkUsRUFBQUEsUUFBUSxFQUFFO0FBSkssQ0FBakI7O0FBT0EsU0FBU2MsUUFBVCxDQUFrQkMsUUFBbEIsRUFBNEJDLElBQTVCLEVBQWtDQyxhQUFsQyxFQUFpRDtBQUMvQyxRQUFNQyxJQUFJLEdBQUdGLElBQUksQ0FBQ0csS0FBTCxDQUFXLEdBQVgsQ0FBYjtBQUNBRCxFQUFBQSxJQUFJLENBQUNFLE1BQUwsQ0FBWSxDQUFDLENBQWIsRUFGK0MsQ0FFOUI7O0FBQ2pCSCxFQUFBQSxhQUFhLEdBQUdBLGFBQWEsSUFBSUksY0FBTUosYUFBdkM7QUFDQUwsRUFBQUEsYUFBYSxDQUFDSyxhQUFELENBQWIsR0FBK0JMLGFBQWEsQ0FBQ0ssYUFBRCxDQUFiLElBQWdDdEIsU0FBUyxFQUF4RTtBQUNBLE1BQUkyQixLQUFLLEdBQUdWLGFBQWEsQ0FBQ0ssYUFBRCxDQUFiLENBQTZCRixRQUE3QixDQUFaOztBQUNBLE9BQUssTUFBTVEsU0FBWCxJQUF3QkwsSUFBeEIsRUFBOEI7QUFDNUJJLElBQUFBLEtBQUssR0FBR0EsS0FBSyxDQUFDQyxTQUFELENBQWI7O0FBQ0EsUUFBSSxDQUFDRCxLQUFMLEVBQVk7QUFDVixhQUFPRSxTQUFQO0FBQ0Q7QUFDRjs7QUFDRCxTQUFPRixLQUFQO0FBQ0Q7O0FBRUQsU0FBU0csR0FBVCxDQUFhVixRQUFiLEVBQXVCQyxJQUF2QixFQUE2QlUsT0FBN0IsRUFBc0NULGFBQXRDLEVBQXFEO0FBQ25ELFFBQU1VLGFBQWEsR0FBR1gsSUFBSSxDQUFDRyxLQUFMLENBQVcsR0FBWCxFQUFnQkMsTUFBaEIsQ0FBdUIsQ0FBQyxDQUF4QixDQUF0QjtBQUNBLFFBQU1FLEtBQUssR0FBR1IsUUFBUSxDQUFDQyxRQUFELEVBQVdDLElBQVgsRUFBaUJDLGFBQWpCLENBQXRCO0FBQ0FLLEVBQUFBLEtBQUssQ0FBQ0ssYUFBRCxDQUFMLEdBQXVCRCxPQUF2QjtBQUNEOztBQUVELFNBQVNFLE1BQVQsQ0FBZ0JiLFFBQWhCLEVBQTBCQyxJQUExQixFQUFnQ0MsYUFBaEMsRUFBK0M7QUFDN0MsUUFBTVUsYUFBYSxHQUFHWCxJQUFJLENBQUNHLEtBQUwsQ0FBVyxHQUFYLEVBQWdCQyxNQUFoQixDQUF1QixDQUFDLENBQXhCLENBQXRCO0FBQ0EsUUFBTUUsS0FBSyxHQUFHUixRQUFRLENBQUNDLFFBQUQsRUFBV0MsSUFBWCxFQUFpQkMsYUFBakIsQ0FBdEI7QUFDQSxTQUFPSyxLQUFLLENBQUNLLGFBQUQsQ0FBWjtBQUNEOztBQUVELFNBQVNFLEdBQVQsQ0FBYWQsUUFBYixFQUF1QkMsSUFBdkIsRUFBNkJDLGFBQTdCLEVBQTRDO0FBQzFDLFFBQU1VLGFBQWEsR0FBR1gsSUFBSSxDQUFDRyxLQUFMLENBQVcsR0FBWCxFQUFnQkMsTUFBaEIsQ0FBdUIsQ0FBQyxDQUF4QixDQUF0QjtBQUNBLFFBQU1FLEtBQUssR0FBR1IsUUFBUSxDQUFDQyxRQUFELEVBQVdDLElBQVgsRUFBaUJDLGFBQWpCLENBQXRCO0FBQ0EsU0FBT0ssS0FBSyxDQUFDSyxhQUFELENBQVo7QUFDRDs7QUFFTSxTQUFTRyxXQUFULENBQ0xDLFlBREssRUFFTEwsT0FGSyxFQUdMTSxpQkFISyxFQUlMZixhQUpLLEVBS0w7QUFDQVEsRUFBQUEsR0FBRyxDQUFDWixRQUFRLENBQUNoQixTQUFWLEVBQXFCa0MsWUFBckIsRUFBbUNMLE9BQW5DLEVBQTRDVCxhQUE1QyxDQUFIO0FBQ0FRLEVBQUFBLEdBQUcsQ0FBQ1osUUFBUSxDQUFDakIsVUFBVixFQUFzQm1DLFlBQXRCLEVBQW9DQyxpQkFBcEMsRUFBdURmLGFBQXZELENBQUg7QUFDRDs7QUFFTSxTQUFTZ0IsTUFBVCxDQUFnQkMsT0FBaEIsRUFBeUJSLE9BQXpCLEVBQWtDVCxhQUFsQyxFQUFpRDtBQUN0RFEsRUFBQUEsR0FBRyxDQUFDWixRQUFRLENBQUNmLElBQVYsRUFBZ0JvQyxPQUFoQixFQUF5QlIsT0FBekIsRUFBa0NULGFBQWxDLENBQUg7QUFDRDs7QUFFTSxTQUFTa0IsVUFBVCxDQUFvQjFCLElBQXBCLEVBQTBCRCxTQUExQixFQUFxQ2tCLE9BQXJDLEVBQThDVCxhQUE5QyxFQUE2RDtBQUNsRVYsRUFBQUEsNEJBQTRCLENBQUNDLFNBQUQsRUFBWUMsSUFBWixDQUE1QjtBQUNBZ0IsRUFBQUEsR0FBRyxDQUFDWixRQUFRLENBQUNiLFFBQVYsRUFBcUIsR0FBRVMsSUFBSyxJQUFHRCxTQUFVLEVBQXpDLEVBQTRDa0IsT0FBNUMsRUFBcURULGFBQXJELENBQUg7QUFDRDs7QUFFTSxTQUFTbUIsd0JBQVQsQ0FBa0NWLE9BQWxDLEVBQTJDVCxhQUEzQyxFQUEwRDtBQUMvREEsRUFBQUEsYUFBYSxHQUFHQSxhQUFhLElBQUlJLGNBQU1KLGFBQXZDO0FBQ0FMLEVBQUFBLGFBQWEsQ0FBQ0ssYUFBRCxDQUFiLEdBQStCTCxhQUFhLENBQUNLLGFBQUQsQ0FBYixJQUFnQ3RCLFNBQVMsRUFBeEU7O0FBQ0FpQixFQUFBQSxhQUFhLENBQUNLLGFBQUQsQ0FBYixDQUE2QmxCLFNBQTdCLENBQXVDc0MsSUFBdkMsQ0FBNENYLE9BQTVDO0FBQ0Q7O0FBRU0sU0FBU1ksY0FBVCxDQUF3QlAsWUFBeEIsRUFBc0NkLGFBQXRDLEVBQXFEO0FBQzFEVyxFQUFBQSxNQUFNLENBQUNmLFFBQVEsQ0FBQ2hCLFNBQVYsRUFBcUJrQyxZQUFyQixFQUFtQ2QsYUFBbkMsQ0FBTjtBQUNEOztBQUVNLFNBQVNzQixhQUFULENBQXVCOUIsSUFBdkIsRUFBNkJELFNBQTdCLEVBQXdDUyxhQUF4QyxFQUF1RDtBQUM1RFcsRUFBQUEsTUFBTSxDQUFDZixRQUFRLENBQUNiLFFBQVYsRUFBcUIsR0FBRVMsSUFBSyxJQUFHRCxTQUFVLEVBQXpDLEVBQTRDUyxhQUE1QyxDQUFOO0FBQ0Q7O0FBRU0sU0FBU3VCLGNBQVQsR0FBMEI7QUFDL0J2QyxFQUFBQSxNQUFNLENBQUNDLElBQVAsQ0FBWVUsYUFBWixFQUEyQjZCLE9BQTNCLENBQW1DQyxLQUFLLElBQUksT0FBTzlCLGFBQWEsQ0FBQzhCLEtBQUQsQ0FBaEU7QUFDRDs7QUFFTSxTQUFTQyxVQUFULENBQW9CbkMsU0FBcEIsRUFBK0JvQyxXQUEvQixFQUE0QzNCLGFBQTVDLEVBQTJEO0FBQ2hFLE1BQUksQ0FBQ0EsYUFBTCxFQUFvQjtBQUNsQixVQUFNLHVCQUFOO0FBQ0Q7O0FBQ0QsU0FBT1ksR0FBRyxDQUFDaEIsUUFBUSxDQUFDYixRQUFWLEVBQXFCLEdBQUU0QyxXQUFZLElBQUdwQyxTQUFVLEVBQWhELEVBQW1EUyxhQUFuRCxDQUFWO0FBQ0Q7O0FBRU0sU0FBUzRCLGFBQVQsQ0FDTHJDLFNBREssRUFFTEMsSUFGSyxFQUdMUSxhQUhLLEVBSUk7QUFDVCxTQUFPMEIsVUFBVSxDQUFDbkMsU0FBRCxFQUFZQyxJQUFaLEVBQWtCUSxhQUFsQixDQUFWLElBQThDTyxTQUFyRDtBQUNEOztBQUVNLFNBQVNzQixXQUFULENBQXFCZixZQUFyQixFQUFtQ2QsYUFBbkMsRUFBa0Q7QUFDdkQsU0FBT1ksR0FBRyxDQUFDaEIsUUFBUSxDQUFDaEIsU0FBVixFQUFxQmtDLFlBQXJCLEVBQW1DZCxhQUFuQyxDQUFWO0FBQ0Q7O0FBRU0sU0FBUzhCLGdCQUFULENBQTBCOUIsYUFBMUIsRUFBeUM7QUFDOUMsUUFBTUssS0FBSyxHQUNSVixhQUFhLENBQUNLLGFBQUQsQ0FBYixJQUNDTCxhQUFhLENBQUNLLGFBQUQsQ0FBYixDQUE2QkosUUFBUSxDQUFDaEIsU0FBdEMsQ0FERixJQUVBLEVBSEY7QUFJQSxRQUFNbUQsYUFBYSxHQUFHLEVBQXRCOztBQUNBLFFBQU1DLG9CQUFvQixHQUFHLENBQUNDLFNBQUQsRUFBWTVCLEtBQVosS0FBc0I7QUFDakRyQixJQUFBQSxNQUFNLENBQUNDLElBQVAsQ0FBWW9CLEtBQVosRUFBbUJtQixPQUFuQixDQUEyQnpCLElBQUksSUFBSTtBQUNqQyxZQUFNbUMsS0FBSyxHQUFHN0IsS0FBSyxDQUFDTixJQUFELENBQW5COztBQUNBLFVBQUlrQyxTQUFKLEVBQWU7QUFDYmxDLFFBQUFBLElBQUksR0FBSSxHQUFFa0MsU0FBVSxJQUFHbEMsSUFBSyxFQUE1QjtBQUNEOztBQUNELFVBQUksT0FBT21DLEtBQVAsS0FBaUIsVUFBckIsRUFBaUM7QUFDL0JILFFBQUFBLGFBQWEsQ0FBQ1gsSUFBZCxDQUFtQnJCLElBQW5CO0FBQ0QsT0FGRCxNQUVPO0FBQ0xpQyxRQUFBQSxvQkFBb0IsQ0FBQ2pDLElBQUQsRUFBT21DLEtBQVAsQ0FBcEI7QUFDRDtBQUNGLEtBVkQ7QUFXRCxHQVpEOztBQWFBRixFQUFBQSxvQkFBb0IsQ0FBQyxJQUFELEVBQU8zQixLQUFQLENBQXBCO0FBQ0EsU0FBTzBCLGFBQVA7QUFDRDs7QUFFTSxTQUFTSSxNQUFULENBQWdCbEIsT0FBaEIsRUFBeUJqQixhQUF6QixFQUF3QztBQUM3QyxTQUFPWSxHQUFHLENBQUNoQixRQUFRLENBQUNmLElBQVYsRUFBZ0JvQyxPQUFoQixFQUF5QmpCLGFBQXpCLENBQVY7QUFDRDs7QUFFTSxTQUFTb0MsT0FBVCxDQUFpQnBDLGFBQWpCLEVBQWdDO0FBQ3JDLE1BQUlxQyxPQUFPLEdBQUcxQyxhQUFhLENBQUNLLGFBQUQsQ0FBM0I7O0FBQ0EsTUFBSXFDLE9BQU8sSUFBSUEsT0FBTyxDQUFDeEQsSUFBdkIsRUFBNkI7QUFDM0IsV0FBT3dELE9BQU8sQ0FBQ3hELElBQWY7QUFDRDs7QUFDRCxTQUFPMEIsU0FBUDtBQUNEOztBQUVNLFNBQVMrQixZQUFULENBQXNCeEIsWUFBdEIsRUFBb0NkLGFBQXBDLEVBQW1EO0FBQ3hELFNBQU9ZLEdBQUcsQ0FBQ2hCLFFBQVEsQ0FBQ2pCLFVBQVYsRUFBc0JtQyxZQUF0QixFQUFvQ2QsYUFBcEMsQ0FBVjtBQUNEOztBQUVNLFNBQVN1QyxnQkFBVCxDQUNMWixXQURLLEVBRUxhLElBRkssRUFHTEMsV0FISyxFQUlMQyxtQkFKSyxFQUtMQyxNQUxLLEVBTUxDLE9BTkssRUFPTDtBQUNBLFFBQU1DLE9BQU8sR0FBRztBQUNkQyxJQUFBQSxXQUFXLEVBQUVuQixXQURDO0FBRWRvQixJQUFBQSxNQUFNLEVBQUVOLFdBRk07QUFHZE8sSUFBQUEsTUFBTSxFQUFFLEtBSE07QUFJZEMsSUFBQUEsR0FBRyxFQUFFTixNQUFNLENBQUNPLGdCQUpFO0FBS2RDLElBQUFBLE9BQU8sRUFBRVIsTUFBTSxDQUFDUSxPQUxGO0FBTWRDLElBQUFBLEVBQUUsRUFBRVQsTUFBTSxDQUFDUztBQU5HLEdBQWhCOztBQVNBLE1BQUlWLG1CQUFKLEVBQXlCO0FBQ3ZCRyxJQUFBQSxPQUFPLENBQUNRLFFBQVIsR0FBbUJYLG1CQUFuQjtBQUNEOztBQUVELE1BQUlmLFdBQVcsS0FBS3pELEtBQUssQ0FBQ0UsVUFBdEIsSUFBb0N1RCxXQUFXLEtBQUt6RCxLQUFLLENBQUNHLFNBQTlELEVBQXlFO0FBQ3ZFO0FBQ0F3RSxJQUFBQSxPQUFPLENBQUNELE9BQVIsR0FBa0I1RCxNQUFNLENBQUNzRSxNQUFQLENBQWMsRUFBZCxFQUFrQlYsT0FBbEIsQ0FBbEI7QUFDRDs7QUFFRCxNQUFJLENBQUNKLElBQUwsRUFBVztBQUNULFdBQU9LLE9BQVA7QUFDRDs7QUFDRCxNQUFJTCxJQUFJLENBQUNlLFFBQVQsRUFBbUI7QUFDakJWLElBQUFBLE9BQU8sQ0FBQyxRQUFELENBQVAsR0FBb0IsSUFBcEI7QUFDRDs7QUFDRCxNQUFJTCxJQUFJLENBQUNnQixJQUFULEVBQWU7QUFDYlgsSUFBQUEsT0FBTyxDQUFDLE1BQUQsQ0FBUCxHQUFrQkwsSUFBSSxDQUFDZ0IsSUFBdkI7QUFDRDs7QUFDRCxNQUFJaEIsSUFBSSxDQUFDaUIsY0FBVCxFQUF5QjtBQUN2QlosSUFBQUEsT0FBTyxDQUFDLGdCQUFELENBQVAsR0FBNEJMLElBQUksQ0FBQ2lCLGNBQWpDO0FBQ0Q7O0FBQ0QsU0FBT1osT0FBUDtBQUNEOztBQUVNLFNBQVNhLHFCQUFULENBQ0wvQixXQURLLEVBRUxhLElBRkssRUFHTG1CLEtBSEssRUFJTEMsS0FKSyxFQUtMakIsTUFMSyxFQU1Ma0IsS0FOSyxFQU9MO0FBQ0FBLEVBQUFBLEtBQUssR0FBRyxDQUFDLENBQUNBLEtBQVY7QUFFQSxNQUFJaEIsT0FBTyxHQUFHO0FBQ1pDLElBQUFBLFdBQVcsRUFBRW5CLFdBREQ7QUFFWmdDLElBQUFBLEtBRlk7QUFHWlgsSUFBQUEsTUFBTSxFQUFFLEtBSEk7QUFJWlksSUFBQUEsS0FKWTtBQUtaWCxJQUFBQSxHQUFHLEVBQUVOLE1BQU0sQ0FBQ08sZ0JBTEE7QUFNWlcsSUFBQUEsS0FOWTtBQU9aVixJQUFBQSxPQUFPLEVBQUVSLE1BQU0sQ0FBQ1EsT0FQSjtBQVFaQyxJQUFBQSxFQUFFLEVBQUVULE1BQU0sQ0FBQ1M7QUFSQyxHQUFkOztBQVdBLE1BQUksQ0FBQ1osSUFBTCxFQUFXO0FBQ1QsV0FBT0ssT0FBUDtBQUNEOztBQUNELE1BQUlMLElBQUksQ0FBQ2UsUUFBVCxFQUFtQjtBQUNqQlYsSUFBQUEsT0FBTyxDQUFDLFFBQUQsQ0FBUCxHQUFvQixJQUFwQjtBQUNEOztBQUNELE1BQUlMLElBQUksQ0FBQ2dCLElBQVQsRUFBZTtBQUNiWCxJQUFBQSxPQUFPLENBQUMsTUFBRCxDQUFQLEdBQWtCTCxJQUFJLENBQUNnQixJQUF2QjtBQUNEOztBQUNELE1BQUloQixJQUFJLENBQUNpQixjQUFULEVBQXlCO0FBQ3ZCWixJQUFBQSxPQUFPLENBQUMsZ0JBQUQsQ0FBUCxHQUE0QkwsSUFBSSxDQUFDaUIsY0FBakM7QUFDRDs7QUFDRCxTQUFPWixPQUFQO0FBQ0QsQyxDQUVEO0FBQ0E7QUFDQTtBQUNBOzs7QUFDTyxTQUFTaUIsaUJBQVQsQ0FBMkJqQixPQUEzQixFQUFvQ2tCLE9BQXBDLEVBQTZDQyxNQUE3QyxFQUFxRDtBQUMxRCxTQUFPO0FBQ0xDLElBQUFBLE9BQU8sRUFBRSxVQUFTQyxRQUFULEVBQW1CO0FBQzFCLFVBQUlyQixPQUFPLENBQUNDLFdBQVIsS0FBd0I1RSxLQUFLLENBQUNPLFNBQWxDLEVBQTZDO0FBQzNDLFlBQUksQ0FBQ3lGLFFBQUwsRUFBZTtBQUNiQSxVQUFBQSxRQUFRLEdBQUdyQixPQUFPLENBQUNzQixPQUFuQjtBQUNEOztBQUNERCxRQUFBQSxRQUFRLEdBQUdBLFFBQVEsQ0FBQ0UsR0FBVCxDQUFhckIsTUFBTSxJQUFJO0FBQ2hDLGlCQUFPQSxNQUFNLENBQUNzQixNQUFQLEVBQVA7QUFDRCxTQUZVLENBQVg7QUFHQSxlQUFPTixPQUFPLENBQUNHLFFBQUQsQ0FBZDtBQUNELE9BVHlCLENBVTFCOzs7QUFDQSxVQUNFQSxRQUFRLElBQ1IsT0FBT0EsUUFBUCxLQUFvQixRQURwQixJQUVBLENBQUNyQixPQUFPLENBQUNFLE1BQVIsQ0FBZXVCLE1BQWYsQ0FBc0JKLFFBQXRCLENBRkQsSUFHQXJCLE9BQU8sQ0FBQ0MsV0FBUixLQUF3QjVFLEtBQUssQ0FBQ0UsVUFKaEMsRUFLRTtBQUNBLGVBQU8yRixPQUFPLENBQUNHLFFBQUQsQ0FBZDtBQUNEOztBQUNELFVBQ0VBLFFBQVEsSUFDUixPQUFPQSxRQUFQLEtBQW9CLFFBRHBCLElBRUFyQixPQUFPLENBQUNDLFdBQVIsS0FBd0I1RSxLQUFLLENBQUNHLFNBSGhDLEVBSUU7QUFDQSxlQUFPMEYsT0FBTyxDQUFDRyxRQUFELENBQWQ7QUFDRDs7QUFDRCxVQUFJckIsT0FBTyxDQUFDQyxXQUFSLEtBQXdCNUUsS0FBSyxDQUFDRyxTQUFsQyxFQUE2QztBQUMzQyxlQUFPMEYsT0FBTyxFQUFkO0FBQ0Q7O0FBQ0RHLE1BQUFBLFFBQVEsR0FBRyxFQUFYOztBQUNBLFVBQUlyQixPQUFPLENBQUNDLFdBQVIsS0FBd0I1RSxLQUFLLENBQUNFLFVBQWxDLEVBQThDO0FBQzVDOEYsUUFBQUEsUUFBUSxDQUFDLFFBQUQsQ0FBUixHQUFxQnJCLE9BQU8sQ0FBQ0UsTUFBUixDQUFld0IsWUFBZixFQUFyQjtBQUNEOztBQUNELGFBQU9SLE9BQU8sQ0FBQ0csUUFBRCxDQUFkO0FBQ0QsS0FuQ0k7QUFvQ0xNLElBQUFBLEtBQUssRUFBRSxVQUFTQSxLQUFULEVBQWdCO0FBQ3JCLFVBQUlBLEtBQUssWUFBWXBFLGNBQU1xRSxLQUEzQixFQUFrQztBQUNoQ1QsUUFBQUEsTUFBTSxDQUFDUSxLQUFELENBQU47QUFDRCxPQUZELE1BRU8sSUFBSUEsS0FBSyxZQUFZQyxLQUFyQixFQUE0QjtBQUNqQ1QsUUFBQUEsTUFBTSxDQUFDLElBQUk1RCxjQUFNcUUsS0FBVixDQUFnQnJFLGNBQU1xRSxLQUFOLENBQVlDLGFBQTVCLEVBQTJDRixLQUFLLENBQUNHLE9BQWpELENBQUQsQ0FBTjtBQUNELE9BRk0sTUFFQTtBQUNMWCxRQUFBQSxNQUFNLENBQUMsSUFBSTVELGNBQU1xRSxLQUFWLENBQWdCckUsY0FBTXFFLEtBQU4sQ0FBWUMsYUFBNUIsRUFBMkNGLEtBQTNDLENBQUQsQ0FBTjtBQUNEO0FBQ0Y7QUE1Q0ksR0FBUDtBQThDRDs7QUFFRCxTQUFTSSxZQUFULENBQXNCcEMsSUFBdEIsRUFBNEI7QUFDMUIsU0FBT0EsSUFBSSxJQUFJQSxJQUFJLENBQUNnQixJQUFiLEdBQW9CaEIsSUFBSSxDQUFDZ0IsSUFBTCxDQUFVcUIsRUFBOUIsR0FBbUN0RSxTQUExQztBQUNEOztBQUVELFNBQVN1RSxtQkFBVCxDQUE2Qm5ELFdBQTdCLEVBQTBDcEMsU0FBMUMsRUFBcUR3RixLQUFyRCxFQUE0RHZDLElBQTVELEVBQWtFO0FBQ2hFLFFBQU13QyxVQUFVLEdBQUdDLGVBQU9DLGtCQUFQLENBQTBCQyxJQUFJLENBQUNDLFNBQUwsQ0FBZUwsS0FBZixDQUExQixDQUFuQjs7QUFDQUUsaUJBQU9JLElBQVAsQ0FDRyxHQUFFMUQsV0FBWSxrQkFBaUJwQyxTQUFVLGFBQVlxRixZQUFZLENBQ2hFcEMsSUFEZ0UsQ0FFaEUsZUFBY3dDLFVBQVcsRUFIN0IsRUFJRTtBQUNFekYsSUFBQUEsU0FERjtBQUVFb0MsSUFBQUEsV0FGRjtBQUdFNkIsSUFBQUEsSUFBSSxFQUFFb0IsWUFBWSxDQUFDcEMsSUFBRDtBQUhwQixHQUpGO0FBVUQ7O0FBRUQsU0FBUzhDLDJCQUFULENBQ0UzRCxXQURGLEVBRUVwQyxTQUZGLEVBR0V3RixLQUhGLEVBSUVRLE1BSkYsRUFLRS9DLElBTEYsRUFNRTtBQUNBLFFBQU13QyxVQUFVLEdBQUdDLGVBQU9DLGtCQUFQLENBQTBCQyxJQUFJLENBQUNDLFNBQUwsQ0FBZUwsS0FBZixDQUExQixDQUFuQjs7QUFDQSxRQUFNUyxXQUFXLEdBQUdQLGVBQU9DLGtCQUFQLENBQTBCQyxJQUFJLENBQUNDLFNBQUwsQ0FBZUcsTUFBZixDQUExQixDQUFwQjs7QUFDQU4saUJBQU9JLElBQVAsQ0FDRyxHQUFFMUQsV0FBWSxrQkFBaUJwQyxTQUFVLGFBQVlxRixZQUFZLENBQ2hFcEMsSUFEZ0UsQ0FFaEUsZUFBY3dDLFVBQVcsZUFBY1EsV0FBWSxFQUh2RCxFQUlFO0FBQ0VqRyxJQUFBQSxTQURGO0FBRUVvQyxJQUFBQSxXQUZGO0FBR0U2QixJQUFBQSxJQUFJLEVBQUVvQixZQUFZLENBQUNwQyxJQUFEO0FBSHBCLEdBSkY7QUFVRDs7QUFFRCxTQUFTaUQseUJBQVQsQ0FBbUM5RCxXQUFuQyxFQUFnRHBDLFNBQWhELEVBQTJEd0YsS0FBM0QsRUFBa0V2QyxJQUFsRSxFQUF3RWdDLEtBQXhFLEVBQStFO0FBQzdFLFFBQU1RLFVBQVUsR0FBR0MsZUFBT0Msa0JBQVAsQ0FBMEJDLElBQUksQ0FBQ0MsU0FBTCxDQUFlTCxLQUFmLENBQTFCLENBQW5COztBQUNBRSxpQkFBT1QsS0FBUCxDQUNHLEdBQUU3QyxXQUFZLGVBQWNwQyxTQUFVLGFBQVlxRixZQUFZLENBQzdEcEMsSUFENkQsQ0FFN0QsZUFBY3dDLFVBQVcsY0FBYUcsSUFBSSxDQUFDQyxTQUFMLENBQWVaLEtBQWYsQ0FBc0IsRUFIaEUsRUFJRTtBQUNFakYsSUFBQUEsU0FERjtBQUVFb0MsSUFBQUEsV0FGRjtBQUdFNkMsSUFBQUEsS0FIRjtBQUlFaEIsSUFBQUEsSUFBSSxFQUFFb0IsWUFBWSxDQUFDcEMsSUFBRDtBQUpwQixHQUpGO0FBV0Q7O0FBRU0sU0FBU2tELHdCQUFULENBQ0wvRCxXQURLLEVBRUxhLElBRkssRUFHTGpELFNBSEssRUFJTDRFLE9BSkssRUFLTHhCLE1BTEssRUFNTDtBQUNBLFNBQU8sSUFBSWdELE9BQUosQ0FBWSxDQUFDNUIsT0FBRCxFQUFVQyxNQUFWLEtBQXFCO0FBQ3RDLFVBQU00QixPQUFPLEdBQUdsRSxVQUFVLENBQUNuQyxTQUFELEVBQVlvQyxXQUFaLEVBQXlCZ0IsTUFBTSxDQUFDM0MsYUFBaEMsQ0FBMUI7O0FBQ0EsUUFBSSxDQUFDNEYsT0FBTCxFQUFjO0FBQ1osYUFBTzdCLE9BQU8sRUFBZDtBQUNEOztBQUNELFVBQU1sQixPQUFPLEdBQUdOLGdCQUFnQixDQUFDWixXQUFELEVBQWNhLElBQWQsRUFBb0IsSUFBcEIsRUFBMEIsSUFBMUIsRUFBZ0NHLE1BQWhDLENBQWhDO0FBQ0EsVUFBTTtBQUFFc0IsTUFBQUEsT0FBRjtBQUFXTyxNQUFBQTtBQUFYLFFBQXFCVixpQkFBaUIsQ0FDMUNqQixPQUQwQyxFQUUxQ0UsTUFBTSxJQUFJO0FBQ1JnQixNQUFBQSxPQUFPLENBQUNoQixNQUFELENBQVA7QUFDRCxLQUp5QyxFQUsxQ3lCLEtBQUssSUFBSTtBQUNQUixNQUFBQSxNQUFNLENBQUNRLEtBQUQsQ0FBTjtBQUNELEtBUHlDLENBQTVDO0FBU0FjLElBQUFBLDJCQUEyQixDQUN6QjNELFdBRHlCLEVBRXpCcEMsU0FGeUIsRUFHekIsV0FIeUIsRUFJekI0RixJQUFJLENBQUNDLFNBQUwsQ0FBZWpCLE9BQWYsQ0FKeUIsRUFLekIzQixJQUx5QixDQUEzQjtBQU9BSyxJQUFBQSxPQUFPLENBQUNzQixPQUFSLEdBQWtCQSxPQUFPLENBQUNDLEdBQVIsQ0FBWXJCLE1BQU0sSUFBSTtBQUN0QztBQUNBQSxNQUFBQSxNQUFNLENBQUN4RCxTQUFQLEdBQW1CQSxTQUFuQjtBQUNBLGFBQU9hLGNBQU1wQixNQUFOLENBQWE2RyxRQUFiLENBQXNCOUMsTUFBdEIsQ0FBUDtBQUNELEtBSmlCLENBQWxCO0FBS0EsV0FBTytDLFlBQVksQ0FDakJuRSxXQURpQixFQUVqQnBDLFNBRmlCLEVBR2pCb0csT0FBTyxDQUFDNUIsT0FBUixHQUNHZ0MsSUFESCxDQUNRLE1BQU07QUFDVixZQUFNN0IsUUFBUSxHQUFHMEIsT0FBTyxDQUFDL0MsT0FBRCxDQUF4Qjs7QUFDQSxVQUFJcUIsUUFBUSxJQUFJLE9BQU9BLFFBQVEsQ0FBQzZCLElBQWhCLEtBQXlCLFVBQXpDLEVBQXFEO0FBQ25ELGVBQU83QixRQUFRLENBQUM2QixJQUFULENBQWNDLE9BQU8sSUFBSTtBQUM5QixjQUFJLENBQUNBLE9BQUwsRUFBYztBQUNaLGtCQUFNLElBQUk1RixjQUFNcUUsS0FBVixDQUNKckUsY0FBTXFFLEtBQU4sQ0FBWUMsYUFEUixFQUVKLHdEQUZJLENBQU47QUFJRDs7QUFDRCxpQkFBT3NCLE9BQVA7QUFDRCxTQVJNLENBQVA7QUFTRDs7QUFDRCxhQUFPOUIsUUFBUDtBQUNELEtBZkgsRUFnQkc2QixJQWhCSCxDQWdCUTlCLE9BaEJSLEVBZ0JpQk8sS0FoQmpCLENBSGlCLENBQW5CO0FBcUJELEdBaERNLEVBZ0RKdUIsSUFoREksQ0FnRENDLE9BQU8sSUFBSTtBQUNqQmxCLElBQUFBLG1CQUFtQixDQUFDbkQsV0FBRCxFQUFjcEMsU0FBZCxFQUF5QjRGLElBQUksQ0FBQ0MsU0FBTCxDQUFlWSxPQUFmLENBQXpCLEVBQWtEeEQsSUFBbEQsQ0FBbkI7QUFDQSxXQUFPd0QsT0FBUDtBQUNELEdBbkRNLENBQVA7QUFvREQ7O0FBRU0sU0FBU0Msb0JBQVQsQ0FDTHRFLFdBREssRUFFTHBDLFNBRkssRUFHTDJHLFNBSEssRUFJTEMsV0FKSyxFQUtMeEQsTUFMSyxFQU1MSCxJQU5LLEVBT0xxQixLQVBLLEVBUUw7QUFDQSxRQUFNK0IsT0FBTyxHQUFHbEUsVUFBVSxDQUFDbkMsU0FBRCxFQUFZb0MsV0FBWixFQUF5QmdCLE1BQU0sQ0FBQzNDLGFBQWhDLENBQTFCOztBQUNBLE1BQUksQ0FBQzRGLE9BQUwsRUFBYztBQUNaLFdBQU9ELE9BQU8sQ0FBQzVCLE9BQVIsQ0FBZ0I7QUFDckJtQyxNQUFBQSxTQURxQjtBQUVyQkMsTUFBQUE7QUFGcUIsS0FBaEIsQ0FBUDtBQUlEOztBQUVELFFBQU1DLFVBQVUsR0FBRyxJQUFJaEcsY0FBTWlHLEtBQVYsQ0FBZ0I5RyxTQUFoQixDQUFuQjs7QUFDQSxNQUFJMkcsU0FBSixFQUFlO0FBQ2JFLElBQUFBLFVBQVUsQ0FBQ0UsTUFBWCxHQUFvQkosU0FBcEI7QUFDRDs7QUFDRCxNQUFJdEMsS0FBSyxHQUFHLEtBQVo7O0FBQ0EsTUFBSXVDLFdBQUosRUFBaUI7QUFDZixRQUFJQSxXQUFXLENBQUNJLE9BQVosSUFBdUJKLFdBQVcsQ0FBQ0ksT0FBWixDQUFvQkMsTUFBcEIsR0FBNkIsQ0FBeEQsRUFBMkQ7QUFDekRKLE1BQUFBLFVBQVUsQ0FBQ0ssUUFBWCxHQUFzQk4sV0FBVyxDQUFDSSxPQUFaLENBQW9CckcsS0FBcEIsQ0FBMEIsR0FBMUIsQ0FBdEI7QUFDRDs7QUFDRCxRQUFJaUcsV0FBVyxDQUFDTyxJQUFoQixFQUFzQjtBQUNwQk4sTUFBQUEsVUFBVSxDQUFDTyxLQUFYLEdBQW1CUixXQUFXLENBQUNPLElBQS9CO0FBQ0Q7O0FBQ0QsUUFBSVAsV0FBVyxDQUFDUyxLQUFoQixFQUF1QjtBQUNyQlIsTUFBQUEsVUFBVSxDQUFDUyxNQUFYLEdBQW9CVixXQUFXLENBQUNTLEtBQWhDO0FBQ0Q7O0FBQ0RoRCxJQUFBQSxLQUFLLEdBQUcsQ0FBQyxDQUFDdUMsV0FBVyxDQUFDdkMsS0FBdEI7QUFDRDs7QUFDRCxRQUFNa0QsYUFBYSxHQUFHcEQscUJBQXFCLENBQ3pDL0IsV0FEeUMsRUFFekNhLElBRnlDLEVBR3pDNEQsVUFIeUMsRUFJekN4QyxLQUp5QyxFQUt6Q2pCLE1BTHlDLEVBTXpDa0IsS0FOeUMsQ0FBM0M7QUFRQSxTQUFPaUMsWUFBWSxDQUNqQm5FLFdBRGlCLEVBRWpCcEMsU0FGaUIsRUFHakJvRyxPQUFPLENBQUM1QixPQUFSLEdBQ0dnQyxJQURILENBQ1EsTUFBTTtBQUNWLFdBQU9ILE9BQU8sQ0FBQ2tCLGFBQUQsQ0FBZDtBQUNELEdBSEgsRUFJR2YsSUFKSCxDQUtJUixNQUFNLElBQUk7QUFDUixRQUFJd0IsV0FBVyxHQUFHWCxVQUFsQjs7QUFDQSxRQUFJYixNQUFNLElBQUlBLE1BQU0sWUFBWW5GLGNBQU1pRyxLQUF0QyxFQUE2QztBQUMzQ1UsTUFBQUEsV0FBVyxHQUFHeEIsTUFBZDtBQUNEOztBQUNELFVBQU15QixTQUFTLEdBQUdELFdBQVcsQ0FBQzFDLE1BQVosRUFBbEI7O0FBQ0EsUUFBSTJDLFNBQVMsQ0FBQ0MsS0FBZCxFQUFxQjtBQUNuQmYsTUFBQUEsU0FBUyxHQUFHYyxTQUFTLENBQUNDLEtBQXRCO0FBQ0Q7O0FBQ0QsUUFBSUQsU0FBUyxDQUFDSixLQUFkLEVBQXFCO0FBQ25CVCxNQUFBQSxXQUFXLEdBQUdBLFdBQVcsSUFBSSxFQUE3QjtBQUNBQSxNQUFBQSxXQUFXLENBQUNTLEtBQVosR0FBb0JJLFNBQVMsQ0FBQ0osS0FBOUI7QUFDRDs7QUFDRCxRQUFJSSxTQUFTLENBQUNOLElBQWQsRUFBb0I7QUFDbEJQLE1BQUFBLFdBQVcsR0FBR0EsV0FBVyxJQUFJLEVBQTdCO0FBQ0FBLE1BQUFBLFdBQVcsQ0FBQ08sSUFBWixHQUFtQk0sU0FBUyxDQUFDTixJQUE3QjtBQUNEOztBQUNELFFBQUlNLFNBQVMsQ0FBQ1QsT0FBZCxFQUF1QjtBQUNyQkosTUFBQUEsV0FBVyxHQUFHQSxXQUFXLElBQUksRUFBN0I7QUFDQUEsTUFBQUEsV0FBVyxDQUFDSSxPQUFaLEdBQXNCUyxTQUFTLENBQUNULE9BQWhDO0FBQ0Q7O0FBQ0QsUUFBSVMsU0FBUyxDQUFDL0gsSUFBZCxFQUFvQjtBQUNsQmtILE1BQUFBLFdBQVcsR0FBR0EsV0FBVyxJQUFJLEVBQTdCO0FBQ0FBLE1BQUFBLFdBQVcsQ0FBQ2xILElBQVosR0FBbUIrSCxTQUFTLENBQUMvSCxJQUE3QjtBQUNEOztBQUNELFFBQUkrSCxTQUFTLENBQUNFLEtBQWQsRUFBcUI7QUFDbkJmLE1BQUFBLFdBQVcsR0FBR0EsV0FBVyxJQUFJLEVBQTdCO0FBQ0FBLE1BQUFBLFdBQVcsQ0FBQ2UsS0FBWixHQUFvQkYsU0FBUyxDQUFDRSxLQUE5QjtBQUNEOztBQUNELFFBQUlKLGFBQWEsQ0FBQ0ssY0FBbEIsRUFBa0M7QUFDaENoQixNQUFBQSxXQUFXLEdBQUdBLFdBQVcsSUFBSSxFQUE3QjtBQUNBQSxNQUFBQSxXQUFXLENBQUNnQixjQUFaLEdBQTZCTCxhQUFhLENBQUNLLGNBQTNDO0FBQ0Q7O0FBQ0QsUUFBSUwsYUFBYSxDQUFDTSxxQkFBbEIsRUFBeUM7QUFDdkNqQixNQUFBQSxXQUFXLEdBQUdBLFdBQVcsSUFBSSxFQUE3QjtBQUNBQSxNQUFBQSxXQUFXLENBQUNpQixxQkFBWixHQUNFTixhQUFhLENBQUNNLHFCQURoQjtBQUVEOztBQUNELFFBQUlOLGFBQWEsQ0FBQ08sc0JBQWxCLEVBQTBDO0FBQ3hDbEIsTUFBQUEsV0FBVyxHQUFHQSxXQUFXLElBQUksRUFBN0I7QUFDQUEsTUFBQUEsV0FBVyxDQUFDa0Isc0JBQVosR0FDRVAsYUFBYSxDQUFDTyxzQkFEaEI7QUFFRDs7QUFDRCxXQUFPO0FBQ0xuQixNQUFBQSxTQURLO0FBRUxDLE1BQUFBO0FBRkssS0FBUDtBQUlELEdBcERMLEVBcURJbUIsR0FBRyxJQUFJO0FBQ0wsUUFBSSxPQUFPQSxHQUFQLEtBQWUsUUFBbkIsRUFBNkI7QUFDM0IsWUFBTSxJQUFJbEgsY0FBTXFFLEtBQVYsQ0FBZ0IsQ0FBaEIsRUFBbUI2QyxHQUFuQixDQUFOO0FBQ0QsS0FGRCxNQUVPO0FBQ0wsWUFBTUEsR0FBTjtBQUNEO0FBQ0YsR0EzREwsQ0FIaUIsQ0FBbkI7QUFpRUQsQyxDQUVEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNPLFNBQVNDLGVBQVQsQ0FDTDVGLFdBREssRUFFTGEsSUFGSyxFQUdMQyxXQUhLLEVBSUxDLG1CQUpLLEVBS0xDLE1BTEssRUFNTEMsT0FOSyxFQU9MO0FBQ0EsTUFBSSxDQUFDSCxXQUFMLEVBQWtCO0FBQ2hCLFdBQU9rRCxPQUFPLENBQUM1QixPQUFSLENBQWdCLEVBQWhCLENBQVA7QUFDRDs7QUFDRCxTQUFPLElBQUk0QixPQUFKLENBQVksVUFBUzVCLE9BQVQsRUFBa0JDLE1BQWxCLEVBQTBCO0FBQzNDLFFBQUk0QixPQUFPLEdBQUdsRSxVQUFVLENBQ3RCZSxXQUFXLENBQUNsRCxTQURVLEVBRXRCb0MsV0FGc0IsRUFHdEJnQixNQUFNLENBQUMzQyxhQUhlLENBQXhCO0FBS0EsUUFBSSxDQUFDNEYsT0FBTCxFQUFjLE9BQU83QixPQUFPLEVBQWQ7QUFDZCxRQUFJbEIsT0FBTyxHQUFHTixnQkFBZ0IsQ0FDNUJaLFdBRDRCLEVBRTVCYSxJQUY0QixFQUc1QkMsV0FINEIsRUFJNUJDLG1CQUo0QixFQUs1QkMsTUFMNEIsRUFNNUJDLE9BTjRCLENBQTlCO0FBUUEsUUFBSTtBQUFFcUIsTUFBQUEsT0FBRjtBQUFXTyxNQUFBQTtBQUFYLFFBQXFCVixpQkFBaUIsQ0FDeENqQixPQUR3QyxFQUV4Q0UsTUFBTSxJQUFJO0FBQ1J1QyxNQUFBQSwyQkFBMkIsQ0FDekIzRCxXQUR5QixFQUV6QmMsV0FBVyxDQUFDbEQsU0FGYSxFQUd6QmtELFdBQVcsQ0FBQzRCLE1BQVosRUFIeUIsRUFJekJ0QixNQUp5QixFQUt6QlAsSUFMeUIsQ0FBM0I7O0FBT0EsVUFDRWIsV0FBVyxLQUFLekQsS0FBSyxDQUFDRSxVQUF0QixJQUNBdUQsV0FBVyxLQUFLekQsS0FBSyxDQUFDRyxTQUZ4QixFQUdFO0FBQ0FXLFFBQUFBLE1BQU0sQ0FBQ3NFLE1BQVAsQ0FBY1YsT0FBZCxFQUF1QkMsT0FBTyxDQUFDRCxPQUEvQjtBQUNEOztBQUNEbUIsTUFBQUEsT0FBTyxDQUFDaEIsTUFBRCxDQUFQO0FBQ0QsS0FqQnVDLEVBa0J4Q3lCLEtBQUssSUFBSTtBQUNQaUIsTUFBQUEseUJBQXlCLENBQ3ZCOUQsV0FEdUIsRUFFdkJjLFdBQVcsQ0FBQ2xELFNBRlcsRUFHdkJrRCxXQUFXLENBQUM0QixNQUFaLEVBSHVCLEVBSXZCN0IsSUFKdUIsRUFLdkJnQyxLQUx1QixDQUF6QjtBQU9BUixNQUFBQSxNQUFNLENBQUNRLEtBQUQsQ0FBTjtBQUNELEtBM0J1QyxDQUExQyxDQWYyQyxDQTZDM0M7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxXQUFPbUIsT0FBTyxDQUFDNUIsT0FBUixHQUNKZ0MsSUFESSxDQUNDLE1BQU07QUFDVixZQUFNeUIsT0FBTyxHQUFHNUIsT0FBTyxDQUFDL0MsT0FBRCxDQUF2Qjs7QUFDQSxVQUNFbEIsV0FBVyxLQUFLekQsS0FBSyxDQUFDRyxTQUF0QixJQUNBc0QsV0FBVyxLQUFLekQsS0FBSyxDQUFDSyxXQUZ4QixFQUdFO0FBQ0F1RyxRQUFBQSxtQkFBbUIsQ0FDakJuRCxXQURpQixFQUVqQmMsV0FBVyxDQUFDbEQsU0FGSyxFQUdqQmtELFdBQVcsQ0FBQzRCLE1BQVosRUFIaUIsRUFJakI3QixJQUppQixDQUFuQjtBQU1ELE9BWlMsQ0FhVjs7O0FBQ0EsVUFBSWIsV0FBVyxLQUFLekQsS0FBSyxDQUFDRSxVQUExQixFQUFzQztBQUNwQyxZQUFJb0osT0FBTyxJQUFJLE9BQU9BLE9BQU8sQ0FBQ3pCLElBQWYsS0FBd0IsVUFBdkMsRUFBbUQ7QUFDakQsaUJBQU95QixPQUFPLENBQUN6QixJQUFSLENBQWE3QixRQUFRLElBQUk7QUFDOUI7QUFDQSxnQkFBSUEsUUFBUSxJQUFJQSxRQUFRLENBQUNuQixNQUF6QixFQUFpQztBQUMvQixxQkFBT21CLFFBQVA7QUFDRDs7QUFDRCxtQkFBTyxJQUFQO0FBQ0QsV0FOTSxDQUFQO0FBT0Q7O0FBQ0QsZUFBTyxJQUFQO0FBQ0Q7O0FBRUQsYUFBT3NELE9BQVA7QUFDRCxLQTdCSSxFQThCSnpCLElBOUJJLENBOEJDOUIsT0E5QkQsRUE4QlVPLEtBOUJWLENBQVA7QUErQkQsR0FqRk0sQ0FBUDtBQWtGRCxDLENBRUQ7QUFDQTs7O0FBQ08sU0FBU2lELE9BQVQsQ0FBaUJDLElBQWpCLEVBQXVCQyxVQUF2QixFQUFtQztBQUN4QyxNQUFJQyxJQUFJLEdBQUcsT0FBT0YsSUFBUCxJQUFlLFFBQWYsR0FBMEJBLElBQTFCLEdBQWlDO0FBQUVuSSxJQUFBQSxTQUFTLEVBQUVtSTtBQUFiLEdBQTVDOztBQUNBLE9BQUssSUFBSXRJLEdBQVQsSUFBZ0J1SSxVQUFoQixFQUE0QjtBQUMxQkMsSUFBQUEsSUFBSSxDQUFDeEksR0FBRCxDQUFKLEdBQVl1SSxVQUFVLENBQUN2SSxHQUFELENBQXRCO0FBQ0Q7O0FBQ0QsU0FBT2dCLGNBQU1wQixNQUFOLENBQWE2RyxRQUFiLENBQXNCK0IsSUFBdEIsQ0FBUDtBQUNEOztBQUVNLFNBQVNDLHlCQUFULENBQ0xILElBREssRUFFTDFILGFBQWEsR0FBR0ksY0FBTUosYUFGakIsRUFHTDtBQUNBLE1BQ0UsQ0FBQ0wsYUFBRCxJQUNBLENBQUNBLGFBQWEsQ0FBQ0ssYUFBRCxDQURkLElBRUEsQ0FBQ0wsYUFBYSxDQUFDSyxhQUFELENBQWIsQ0FBNkJsQixTQUhoQyxFQUlFO0FBQ0E7QUFDRDs7QUFDRGEsRUFBQUEsYUFBYSxDQUFDSyxhQUFELENBQWIsQ0FBNkJsQixTQUE3QixDQUF1QzBDLE9BQXZDLENBQStDZixPQUFPLElBQUlBLE9BQU8sQ0FBQ2lILElBQUQsQ0FBakU7QUFDRDs7QUFFRCxTQUFTNUIsWUFBVCxDQUFzQnRHLElBQXRCLEVBQTRCRCxTQUE1QixFQUF1Q2lJLE9BQU8sR0FBRzdCLE9BQU8sQ0FBQzVCLE9BQVIsRUFBakQsRUFBb0U7QUFDbEUsUUFBTStELE1BQU0sR0FBRzlKLE9BQU8sQ0FBQytKLFVBQVIsRUFBZjs7QUFDQSxNQUFJLENBQUNELE1BQUwsRUFBYTtBQUNYLFdBQU9OLE9BQVA7QUFDRDs7QUFDRCxTQUFPLElBQUk3QixPQUFKLENBQVksQ0FBQzVCLE9BQUQsRUFBVUMsTUFBVixLQUFxQjtBQUN0Q2hHLElBQUFBLE9BQU8sQ0FBQ2dLLGdCQUFSLENBQ0cseUJBQXdCeEksSUFBSyxJQUFHRCxTQUFVLEVBRDdDLEVBRUUwSSxVQUFVLElBQUk7QUFDWkEsTUFBQUEsVUFBVSxJQUFJQSxVQUFVLENBQUNDLGFBQVgsQ0FBeUIsWUFBekIsRUFBdUMsVUFBdkMsQ0FBZDtBQUNBRCxNQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0MsYUFBWCxDQUF5QixNQUF6QixFQUFpQzFJLElBQWpDLENBQWQ7QUFDQXlJLE1BQUFBLFVBQVUsSUFBSUEsVUFBVSxDQUFDQyxhQUFYLENBQXlCLFdBQXpCLEVBQXNDM0ksU0FBdEMsQ0FBZDtBQUNBaUksTUFBQUEsT0FBTyxDQUFDekIsSUFBUixDQUNFLFVBQVNSLE1BQVQsRUFBaUI7QUFDZnhCLFFBQUFBLE9BQU8sQ0FBQ3dCLE1BQUQsQ0FBUDtBQUNBMEMsUUFBQUEsVUFBVSxJQUFJQSxVQUFVLENBQUNFLEtBQVgsRUFBZDtBQUNELE9BSkgsRUFLRSxVQUFTM0QsS0FBVCxFQUFnQjtBQUNkUixRQUFBQSxNQUFNLENBQUNRLEtBQUQsQ0FBTjtBQUNBeUQsUUFBQUEsVUFBVSxJQUFJQSxVQUFVLENBQUNFLEtBQVgsQ0FBaUIzRCxLQUFqQixDQUFkO0FBQ0QsT0FSSDtBQVVELEtBaEJIO0FBa0JELEdBbkJNLENBQVA7QUFvQkQiLCJzb3VyY2VzQ29udGVudCI6WyIvLyB0cmlnZ2Vycy5qc1xuY29uc3QgQVdTWFJheSA9IHJlcXVpcmUoJ2F3cy14cmF5LXNkaycpO1xuXG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tICcuL2xvZ2dlcic7XG5cbmV4cG9ydCBjb25zdCBUeXBlcyA9IHtcbiAgYmVmb3JlTG9naW46ICdiZWZvcmVMb2dpbicsXG4gIGJlZm9yZVNhdmU6ICdiZWZvcmVTYXZlJyxcbiAgYWZ0ZXJTYXZlOiAnYWZ0ZXJTYXZlJyxcbiAgYmVmb3JlRGVsZXRlOiAnYmVmb3JlRGVsZXRlJyxcbiAgYWZ0ZXJEZWxldGU6ICdhZnRlckRlbGV0ZScsXG4gIGJlZm9yZUZpbmQ6ICdiZWZvcmVGaW5kJyxcbiAgYWZ0ZXJGaW5kOiAnYWZ0ZXJGaW5kJyxcbn07XG5cbmNvbnN0IGJhc2VTdG9yZSA9IGZ1bmN0aW9uKCkge1xuICBjb25zdCBWYWxpZGF0b3JzID0ge307XG4gIGNvbnN0IEZ1bmN0aW9ucyA9IHt9O1xuICBjb25zdCBKb2JzID0ge307XG4gIGNvbnN0IExpdmVRdWVyeSA9IFtdO1xuICBjb25zdCBUcmlnZ2VycyA9IE9iamVjdC5rZXlzKFR5cGVzKS5yZWR1Y2UoZnVuY3Rpb24oYmFzZSwga2V5KSB7XG4gICAgYmFzZVtrZXldID0ge307XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sIHt9KTtcblxuICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7XG4gICAgRnVuY3Rpb25zLFxuICAgIEpvYnMsXG4gICAgVmFsaWRhdG9ycyxcbiAgICBUcmlnZ2VycyxcbiAgICBMaXZlUXVlcnksXG4gIH0pO1xufTtcblxuZnVuY3Rpb24gdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpIHtcbiAgY29uc3QgcmVzdHJpY3RlZENsYXNzTmFtZXMgPSBbJ19TZXNzaW9uJ107XG4gIGlmIChyZXN0cmljdGVkQ2xhc3NOYW1lcy5pbmRleE9mKGNsYXNzTmFtZSkgIT0gLTEpIHtcbiAgICB0aHJvdyBgVHJpZ2dlcnMgYXJlIG5vdCBzdXBwb3J0ZWQgZm9yICR7Y2xhc3NOYW1lfSBjbGFzcy5gO1xuICB9XG4gIGlmICh0eXBlID09IFR5cGVzLmJlZm9yZVNhdmUgJiYgY2xhc3NOYW1lID09PSAnX1B1c2hTdGF0dXMnKSB7XG4gICAgLy8gX1B1c2hTdGF0dXMgdXNlcyB1bmRvY3VtZW50ZWQgbmVzdGVkIGtleSBpbmNyZW1lbnQgb3BzXG4gICAgLy8gYWxsb3dpbmcgYmVmb3JlU2F2ZSB3b3VsZCBtZXNzIHVwIHRoZSBvYmplY3RzIGJpZyB0aW1lXG4gICAgLy8gVE9ETzogQWxsb3cgcHJvcGVyIGRvY3VtZW50ZWQgd2F5IG9mIHVzaW5nIG5lc3RlZCBpbmNyZW1lbnQgb3BzXG4gICAgdGhyb3cgJ09ubHkgYWZ0ZXJTYXZlIGlzIGFsbG93ZWQgb24gX1B1c2hTdGF0dXMnO1xuICB9XG4gIGlmICh0eXBlID09PSBUeXBlcy5iZWZvcmVMb2dpbiAmJiBjbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9Vc2VyIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBiZWZvcmVMb2dpbiB0cmlnZ2VyJztcbiAgfVxuICByZXR1cm4gY2xhc3NOYW1lO1xufVxuXG5jb25zdCBfdHJpZ2dlclN0b3JlID0ge307XG5cbmNvbnN0IENhdGVnb3J5ID0ge1xuICBGdW5jdGlvbnM6ICdGdW5jdGlvbnMnLFxuICBWYWxpZGF0b3JzOiAnVmFsaWRhdG9ycycsXG4gIEpvYnM6ICdKb2JzJyxcbiAgVHJpZ2dlcnM6ICdUcmlnZ2VycycsXG59O1xuXG5mdW5jdGlvbiBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBwYXRoID0gbmFtZS5zcGxpdCgnLicpO1xuICBwYXRoLnNwbGljZSgtMSk7IC8vIHJlbW92ZSBsYXN0IGNvbXBvbmVudFxuICBhcHBsaWNhdGlvbklkID0gYXBwbGljYXRpb25JZCB8fCBQYXJzZS5hcHBsaWNhdGlvbklkO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCBiYXNlU3RvcmUoKTtcbiAgbGV0IHN0b3JlID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXVtjYXRlZ29yeV07XG4gIGZvciAoY29uc3QgY29tcG9uZW50IG9mIHBhdGgpIHtcbiAgICBzdG9yZSA9IHN0b3JlW2NvbXBvbmVudF07XG4gICAgaWYgKCFzdG9yZSkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHN0b3JlO1xufVxuXG5mdW5jdGlvbiBhZGQoY2F0ZWdvcnksIG5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgc3RvcmVbbGFzdENvbXBvbmVudF0gPSBoYW5kbGVyO1xufVxuXG5mdW5jdGlvbiByZW1vdmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgZGVsZXRlIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5mdW5jdGlvbiBnZXQoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgcmV0dXJuIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkRnVuY3Rpb24oXG4gIGZ1bmN0aW9uTmFtZSxcbiAgaGFuZGxlcixcbiAgdmFsaWRhdGlvbkhhbmRsZXIsXG4gIGFwcGxpY2F0aW9uSWRcbikge1xuICBhZGQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRKb2Ioam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICB2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzKGNsYXNzTmFtZSwgdHlwZSk7XG4gIGFkZChDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRMaXZlUXVlcnlFdmVudEhhbmRsZXIoaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhcHBsaWNhdGlvbklkID0gYXBwbGljYXRpb25JZCB8fCBQYXJzZS5hcHBsaWNhdGlvbklkO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCBiYXNlU3RvcmUoKTtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkucHVzaChoYW5kbGVyKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZUZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZW1vdmUoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlVHJpZ2dlcih0eXBlLCBjbGFzc05hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmVtb3ZlKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke2NsYXNzTmFtZX1gLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF91bnJlZ2lzdGVyQWxsKCkge1xuICBPYmplY3Qua2V5cyhfdHJpZ2dlclN0b3JlKS5mb3JFYWNoKGFwcElkID0+IGRlbGV0ZSBfdHJpZ2dlclN0b3JlW2FwcElkXSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgaWYgKCFhcHBsaWNhdGlvbklkKSB7XG4gICAgdGhyb3cgJ01pc3NpbmcgQXBwbGljYXRpb25JRCc7XG4gIH1cbiAgcmV0dXJuIGdldChDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHJpZ2dlclR5cGV9LiR7Y2xhc3NOYW1lfWAsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHJpZ2dlckV4aXN0cyhcbiAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gIHR5cGU6IHN0cmluZyxcbiAgYXBwbGljYXRpb25JZDogc3RyaW5nXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0eXBlLCBhcHBsaWNhdGlvbklkKSAhPSB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbk5hbWVzKGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3Qgc3RvcmUgPVxuICAgIChfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdICYmXG4gICAgICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW0NhdGVnb3J5LkZ1bmN0aW9uc10pIHx8XG4gICAge307XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZXMgPSBbXTtcbiAgY29uc3QgZXh0cmFjdEZ1bmN0aW9uTmFtZXMgPSAobmFtZXNwYWNlLCBzdG9yZSkgPT4ge1xuICAgIE9iamVjdC5rZXlzKHN0b3JlKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzdG9yZVtuYW1lXTtcbiAgICAgIGlmIChuYW1lc3BhY2UpIHtcbiAgICAgICAgbmFtZSA9IGAke25hbWVzcGFjZX0uJHtuYW1lfWA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZXMucHVzaChuYW1lKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG5hbWUsIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbiAgZXh0cmFjdEZ1bmN0aW9uTmFtZXMobnVsbCwgc3RvcmUpO1xuICByZXR1cm4gZnVuY3Rpb25OYW1lcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEpvYihqb2JOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2JzKGFwcGxpY2F0aW9uSWQpIHtcbiAgdmFyIG1hbmFnZXIgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdO1xuICBpZiAobWFuYWdlciAmJiBtYW5hZ2VyLkpvYnMpIHtcbiAgICByZXR1cm4gbWFuYWdlci5Kb2JzO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRWYWxpZGF0b3IoZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RPYmplY3QoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0XG4pIHtcbiAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgb2JqZWN0OiBwYXJzZU9iamVjdCxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgfTtcblxuICBpZiAob3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgIHJlcXVlc3Qub3JpZ2luYWwgPSBvcmlnaW5hbFBhcnNlT2JqZWN0O1xuICB9XG5cbiAgaWYgKHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlIHx8IHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAvLyBTZXQgYSBjb3B5IG9mIHRoZSBjb250ZXh0IG9uIHRoZSByZXF1ZXN0IG9iamVjdC5cbiAgICByZXF1ZXN0LmNvbnRleHQgPSBPYmplY3QuYXNzaWduKHt9LCBjb250ZXh0KTtcbiAgfVxuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RRdWVyeU9iamVjdChcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHF1ZXJ5LFxuICBjb3VudCxcbiAgY29uZmlnLFxuICBpc0dldFxuKSB7XG4gIGlzR2V0ID0gISFpc0dldDtcblxuICB2YXIgcmVxdWVzdCA9IHtcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgcXVlcnksXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBjb3VudCxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGlzR2V0LFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gIH07XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG4vLyBDcmVhdGVzIHRoZSByZXNwb25zZSBvYmplY3QsIGFuZCB1c2VzIHRoZSByZXF1ZXN0IG9iamVjdCB0byBwYXNzIGRhdGFcbi8vIFRoZSBBUEkgd2lsbCBjYWxsIHRoaXMgd2l0aCBSRVNUIEFQSSBmb3JtYXR0ZWQgb2JqZWN0cywgdGhpcyB3aWxsXG4vLyB0cmFuc2Zvcm0gdGhlbSB0byBQYXJzZS5PYmplY3QgaW5zdGFuY2VzIGV4cGVjdGVkIGJ5IENsb3VkIENvZGUuXG4vLyBBbnkgY2hhbmdlcyBtYWRlIHRvIHRoZSBvYmplY3QgaW4gYSBiZWZvcmVTYXZlIHdpbGwgYmUgaW5jbHVkZWQuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVzcG9uc2VPYmplY3QocmVxdWVzdCwgcmVzb2x2ZSwgcmVqZWN0KSB7XG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlckZpbmQpIHtcbiAgICAgICAgaWYgKCFyZXNwb25zZSkge1xuICAgICAgICAgIHJlc3BvbnNlID0gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIHJlc3BvbnNlID0gcmVzcG9uc2UubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdC50b0pTT04oKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIC8vIFVzZSB0aGUgSlNPTiByZXNwb25zZVxuICAgICAgaWYgKFxuICAgICAgICByZXNwb25zZSAmJlxuICAgICAgICB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmXG4gICAgICAgICFyZXF1ZXN0Lm9iamVjdC5lcXVhbHMocmVzcG9uc2UpICYmXG4gICAgICAgIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmVcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIHJlc3BvbnNlICYmXG4gICAgICAgIHR5cGVvZiByZXNwb25zZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgcmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZSgpO1xuICAgICAgfVxuICAgICAgcmVzcG9uc2UgPSB7fTtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXSA9IHJlcXVlc3Qub2JqZWN0Ll9nZXRTYXZlSlNPTigpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgIH0sXG4gICAgZXJyb3I6IGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfSBlbHNlIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICAgIHJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCwgZXJyb3IubWVzc2FnZSkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELCBlcnJvcikpO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHVzZXJJZEZvckxvZyhhdXRoKSB7XG4gIHJldHVybiBhdXRoICYmIGF1dGgudXNlciA/IGF1dGgudXNlci5pZCA6IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckFmdGVySG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCkge1xuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBsb2dnZXIuaW5mbyhcbiAgICBgJHt0cmlnZ2VyVHlwZX0gdHJpZ2dlcmVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06XFxuICBJbnB1dDogJHtjbGVhbklucHV0fWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gIHRyaWdnZXJUeXBlLFxuICBjbGFzc05hbWUsXG4gIGlucHV0LFxuICByZXN1bHQsXG4gIGF1dGhcbikge1xuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBjb25zdCBjbGVhblJlc3VsdCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gIGxvZ2dlci5pbmZvKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9XFxuICBSZXN1bHQ6ICR7Y2xlYW5SZXN1bHR9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIGF1dGgsIGVycm9yKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGxvZ2dlci5lcnJvcihcbiAgICBgJHt0cmlnZ2VyVHlwZX0gZmFpbGVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06XFxuICBJbnB1dDogJHtjbGVhbklucHV0fVxcbiAgRXJyb3I6ICR7SlNPTi5zdHJpbmdpZnkoZXJyb3IpfWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBlcnJvcixcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBjbGFzc05hbWUsXG4gIG9iamVjdHMsXG4gIGNvbmZpZ1xuKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikge1xuICAgICAgcmV0dXJuIHJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIG51bGwsIG51bGwsIGNvbmZpZyk7XG4gICAgY29uc3QgeyBzdWNjZXNzLCBlcnJvciB9ID0gZ2V0UmVzcG9uc2VPYmplY3QoXG4gICAgICByZXF1ZXN0LFxuICAgICAgb2JqZWN0ID0+IHtcbiAgICAgICAgcmVzb2x2ZShvYmplY3QpO1xuICAgICAgfSxcbiAgICAgIGVycm9yID0+IHtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH1cbiAgICApO1xuICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgJ0FmdGVyRmluZCcsXG4gICAgICBKU09OLnN0cmluZ2lmeShvYmplY3RzKSxcbiAgICAgIGF1dGhcbiAgICApO1xuICAgIHJlcXVlc3Qub2JqZWN0cyA9IG9iamVjdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAvL3NldHRpbmcgdGhlIGNsYXNzIG5hbWUgdG8gdHJhbnNmb3JtIGludG8gcGFyc2Ugb2JqZWN0XG4gICAgICBvYmplY3QuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICAgICAgcmV0dXJuIFBhcnNlLk9iamVjdC5mcm9tSlNPTihvYmplY3QpO1xuICAgIH0pO1xuICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICBjb25zdCByZXNwb25zZSA9IHRyaWdnZXIocmVxdWVzdCk7XG4gICAgICAgICAgaWYgKHJlc3BvbnNlICYmIHR5cGVvZiByZXNwb25zZS50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2UudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgICAgaWYgKCFyZXN1bHRzKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgICAgICAgICAgICdBZnRlckZpbmQgZXhwZWN0IHJlc3VsdHMgdG8gYmUgcmV0dXJuZWQgaW4gdGhlIHByb21pc2UnXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKHN1Y2Nlc3MsIGVycm9yKVxuICAgICk7XG4gIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgbG9nVHJpZ2dlckFmdGVySG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBKU09OLnN0cmluZ2lmeShyZXN1bHRzKSwgYXV0aCk7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5RdWVyeVRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBjbGFzc05hbWUsXG4gIHJlc3RXaGVyZSxcbiAgcmVzdE9wdGlvbnMsXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgaXNHZXRcbikge1xuICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdHJpZ2dlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe1xuICAgICAgcmVzdFdoZXJlLFxuICAgICAgcmVzdE9wdGlvbnMsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBwYXJzZVF1ZXJ5ID0gbmV3IFBhcnNlLlF1ZXJ5KGNsYXNzTmFtZSk7XG4gIGlmIChyZXN0V2hlcmUpIHtcbiAgICBwYXJzZVF1ZXJ5Ll93aGVyZSA9IHJlc3RXaGVyZTtcbiAgfVxuICBsZXQgY291bnQgPSBmYWxzZTtcbiAgaWYgKHJlc3RPcHRpb25zKSB7XG4gICAgaWYgKHJlc3RPcHRpb25zLmluY2x1ZGUgJiYgcmVzdE9wdGlvbnMuaW5jbHVkZS5sZW5ndGggPiAwKSB7XG4gICAgICBwYXJzZVF1ZXJ5Ll9pbmNsdWRlID0gcmVzdE9wdGlvbnMuaW5jbHVkZS5zcGxpdCgnLCcpO1xuICAgIH1cbiAgICBpZiAocmVzdE9wdGlvbnMuc2tpcCkge1xuICAgICAgcGFyc2VRdWVyeS5fc2tpcCA9IHJlc3RPcHRpb25zLnNraXA7XG4gICAgfVxuICAgIGlmIChyZXN0T3B0aW9ucy5saW1pdCkge1xuICAgICAgcGFyc2VRdWVyeS5fbGltaXQgPSByZXN0T3B0aW9ucy5saW1pdDtcbiAgICB9XG4gICAgY291bnQgPSAhIXJlc3RPcHRpb25zLmNvdW50O1xuICB9XG4gIGNvbnN0IHJlcXVlc3RPYmplY3QgPSBnZXRSZXF1ZXN0UXVlcnlPYmplY3QoXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgYXV0aCxcbiAgICBwYXJzZVF1ZXJ5LFxuICAgIGNvdW50LFxuICAgIGNvbmZpZyxcbiAgICBpc0dldFxuICApO1xuICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgIHRyaWdnZXJUeXBlLFxuICAgIGNsYXNzTmFtZSxcbiAgICBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdHJpZ2dlcihyZXF1ZXN0T2JqZWN0KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihcbiAgICAgICAgcmVzdWx0ID0+IHtcbiAgICAgICAgICBsZXQgcXVlcnlSZXN1bHQgPSBwYXJzZVF1ZXJ5O1xuICAgICAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0IGluc3RhbmNlb2YgUGFyc2UuUXVlcnkpIHtcbiAgICAgICAgICAgIHF1ZXJ5UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBqc29uUXVlcnkgPSBxdWVyeVJlc3VsdC50b0pTT04oKTtcbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LndoZXJlKSB7XG4gICAgICAgICAgICByZXN0V2hlcmUgPSBqc29uUXVlcnkud2hlcmU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkubGltaXQpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5saW1pdCA9IGpzb25RdWVyeS5saW1pdDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5za2lwKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuc2tpcCA9IGpzb25RdWVyeS5za2lwO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LmluY2x1ZGUpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlID0ganNvblF1ZXJ5LmluY2x1ZGU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkua2V5cykge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLmtleXMgPSBqc29uUXVlcnkua2V5cztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5vcmRlcikge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLm9yZGVyID0ganNvblF1ZXJ5Lm9yZGVyO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QuaW5jbHVkZVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID1cbiAgICAgICAgICAgICAgcmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID1cbiAgICAgICAgICAgICAgcmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICAgICAgcmVzdE9wdGlvbnMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSxcbiAgICAgICAgZXJyID0+IHtcbiAgICAgICAgICBpZiAodHlwZW9mIGVyciA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxLCBlcnIpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICApXG4gICk7XG59XG5cbi8vIFRvIGJlIHVzZWQgYXMgcGFydCBvZiB0aGUgcHJvbWlzZSBjaGFpbiB3aGVuIHNhdmluZy9kZWxldGluZyBhbiBvYmplY3Rcbi8vIFdpbGwgcmVzb2x2ZSBzdWNjZXNzZnVsbHkgaWYgbm8gdHJpZ2dlciBpcyBjb25maWd1cmVkXG4vLyBSZXNvbHZlcyB0byBhbiBvYmplY3QsIGVtcHR5IG9yIGNvbnRhaW5pbmcgYW4gb2JqZWN0IGtleS4gQSBiZWZvcmVTYXZlXG4vLyB0cmlnZ2VyIHdpbGwgc2V0IHRoZSBvYmplY3Qga2V5IHRvIHRoZSByZXN0IGZvcm1hdCBvYmplY3QgdG8gc2F2ZS5cbi8vIG9yaWdpbmFsUGFyc2VPYmplY3QgaXMgb3B0aW9uYWwsIHdlIG9ubHkgbmVlZCB0aGF0IGZvciBiZWZvcmUvYWZ0ZXJTYXZlIGZ1bmN0aW9uc1xuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihcbiAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgICApO1xuICAgIGlmICghdHJpZ2dlcikgcmV0dXJuIHJlc29sdmUoKTtcbiAgICB2YXIgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QoXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGF1dGgsXG4gICAgICBwYXJzZU9iamVjdCxcbiAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICBjb25maWcsXG4gICAgICBjb250ZXh0XG4gICAgKTtcbiAgICB2YXIgeyBzdWNjZXNzLCBlcnJvciB9ID0gZ2V0UmVzcG9uc2VPYmplY3QoXG4gICAgICByZXF1ZXN0LFxuICAgICAgb2JqZWN0ID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgYXV0aFxuICAgICAgICApO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlXG4gICAgICAgICkge1xuICAgICAgICAgIE9iamVjdC5hc3NpZ24oY29udGV4dCwgcmVxdWVzdC5jb250ZXh0KTtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKG9iamVjdCk7XG4gICAgICB9LFxuICAgICAgZXJyb3IgPT4ge1xuICAgICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIGVycm9yXG4gICAgICAgICk7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIEFmdGVyU2F2ZSBhbmQgYWZ0ZXJEZWxldGUgdHJpZ2dlcnMgY2FuIHJldHVybiBhIHByb21pc2UsIHdoaWNoIGlmIHRoZXlcbiAgICAvLyBkbywgbmVlZHMgdG8gYmUgcmVzb2x2ZWQgYmVmb3JlIHRoaXMgcHJvbWlzZSBpcyByZXNvbHZlZCxcbiAgICAvLyBzbyB0cmlnZ2VyIGV4ZWN1dGlvbiBpcyBzeW5jZWQgd2l0aCBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgLy8gSWYgdHJpZ2dlcnMgZG8gbm90IHJldHVybiBhIHByb21pc2UsIHRoZXkgY2FuIHJ1biBhc3luYyBjb2RlIHBhcmFsbGVsXG4gICAgLy8gdG8gdGhlIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgY29uc3QgcHJvbWlzZSA9IHRyaWdnZXIocmVxdWVzdCk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlXG4gICAgICAgICkge1xuICAgICAgICAgIGxvZ1RyaWdnZXJBZnRlckhvb2soXG4gICAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgICAgYXV0aFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gYmVmb3JlU2F2ZSBpcyBleHBlY3RlZCB0byByZXR1cm4gbnVsbCAobm90aGluZylcbiAgICAgICAgaWYgKHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgICAgaWYgKHByb21pc2UgJiYgdHlwZW9mIHByb21pc2UudGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHByb21pc2UudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgICAgICAgIC8vIHJlc3BvbnNlLm9iamVjdCBtYXkgY29tZSBmcm9tIGV4cHJlc3Mgcm91dGluZyBiZWZvcmUgaG9va1xuICAgICAgICAgICAgICBpZiAocmVzcG9uc2UgJiYgcmVzcG9uc2Uub2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgICB9KVxuICAgICAgLnRoZW4oc3VjY2VzcywgZXJyb3IpO1xuICB9KTtcbn1cblxuLy8gQ29udmVydHMgYSBSRVNULWZvcm1hdCBvYmplY3QgdG8gYSBQYXJzZS5PYmplY3Rcbi8vIGRhdGEgaXMgZWl0aGVyIGNsYXNzTmFtZSBvciBhbiBvYmplY3RcbmV4cG9ydCBmdW5jdGlvbiBpbmZsYXRlKGRhdGEsIHJlc3RPYmplY3QpIHtcbiAgdmFyIGNvcHkgPSB0eXBlb2YgZGF0YSA9PSAnb2JqZWN0JyA/IGRhdGEgOiB7IGNsYXNzTmFtZTogZGF0YSB9O1xuICBmb3IgKHZhciBrZXkgaW4gcmVzdE9iamVjdCkge1xuICAgIGNvcHlba2V5XSA9IHJlc3RPYmplY3Rba2V5XTtcbiAgfVxuICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKGNvcHkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyhcbiAgZGF0YSxcbiAgYXBwbGljYXRpb25JZCA9IFBhcnNlLmFwcGxpY2F0aW9uSWRcbikge1xuICBpZiAoXG4gICAgIV90cmlnZ2VyU3RvcmUgfHxcbiAgICAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fFxuICAgICFfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkuZm9yRWFjaChoYW5kbGVyID0+IGhhbmRsZXIoZGF0YSkpO1xufVxuXG5mdW5jdGlvbiB0cmFjZVByb21pc2UodHlwZSwgY2xhc3NOYW1lLCBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCkpIHtcbiAgY29uc3QgcGFyZW50ID0gQVdTWFJheS5nZXRTZWdtZW50KCk7XG4gIGlmICghcGFyZW50KSB7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBBV1NYUmF5LmNhcHR1cmVBc3luY0Z1bmMoXG4gICAgICBgUGFyc2UtU2VydmVyX3RyaWdnZXJzXyR7dHlwZX1fJHtjbGFzc05hbWV9YCxcbiAgICAgIHN1YnNlZ21lbnQgPT4ge1xuICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ29udHJvbGxlcicsICd0cmlnZ2VycycpO1xuICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignVHlwZScsIHR5cGUpO1xuICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ2xhc3NOYW1lJywgY2xhc3NOYW1lKTtcbiAgICAgICAgcHJvbWlzZS50aGVuKFxuICAgICAgICAgIGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBmdW5jdGlvbihlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5jbG9zZShlcnJvcik7XG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgfVxuICAgICk7XG4gIH0pO1xufVxuIl19