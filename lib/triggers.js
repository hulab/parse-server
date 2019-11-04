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
    AWSXRay.captureAsyncFunc('Parse-Server', subsegment => {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJuYW1lcyI6WyJBV1NYUmF5IiwicmVxdWlyZSIsIlR5cGVzIiwiYmVmb3JlTG9naW4iLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmFzZVN0b3JlIiwiVmFsaWRhdG9ycyIsIkZ1bmN0aW9ucyIsIkpvYnMiLCJMaXZlUXVlcnkiLCJUcmlnZ2VycyIsIk9iamVjdCIsImtleXMiLCJyZWR1Y2UiLCJiYXNlIiwia2V5IiwiZnJlZXplIiwidmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyIsImNsYXNzTmFtZSIsInR5cGUiLCJyZXN0cmljdGVkQ2xhc3NOYW1lcyIsImluZGV4T2YiLCJfdHJpZ2dlclN0b3JlIiwiQ2F0ZWdvcnkiLCJnZXRTdG9yZSIsImNhdGVnb3J5IiwibmFtZSIsImFwcGxpY2F0aW9uSWQiLCJwYXRoIiwic3BsaXQiLCJzcGxpY2UiLCJQYXJzZSIsInN0b3JlIiwiY29tcG9uZW50IiwidW5kZWZpbmVkIiwiYWRkIiwiaGFuZGxlciIsImxhc3RDb21wb25lbnQiLCJyZW1vdmUiLCJnZXQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRMaXZlUXVlcnlFdmVudEhhbmRsZXIiLCJwdXNoIiwicmVtb3ZlRnVuY3Rpb24iLCJyZW1vdmVUcmlnZ2VyIiwiX3VucmVnaXN0ZXJBbGwiLCJmb3JFYWNoIiwiYXBwSWQiLCJnZXRUcmlnZ2VyIiwidHJpZ2dlclR5cGUiLCJ0cmlnZ2VyRXhpc3RzIiwiZ2V0RnVuY3Rpb24iLCJnZXRGdW5jdGlvbk5hbWVzIiwiZnVuY3Rpb25OYW1lcyIsImV4dHJhY3RGdW5jdGlvbk5hbWVzIiwibmFtZXNwYWNlIiwidmFsdWUiLCJnZXRKb2IiLCJnZXRKb2JzIiwibWFuYWdlciIsImdldFZhbGlkYXRvciIsImdldFJlcXVlc3RPYmplY3QiLCJhdXRoIiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsInJlcXVlc3QiLCJ0cmlnZ2VyTmFtZSIsIm9iamVjdCIsIm1hc3RlciIsImxvZyIsImxvZ2dlckNvbnRyb2xsZXIiLCJoZWFkZXJzIiwiaXAiLCJvcmlnaW5hbCIsImFzc2lnbiIsImlzTWFzdGVyIiwidXNlciIsImluc3RhbGxhdGlvbklkIiwiZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0IiwicXVlcnkiLCJjb3VudCIsImlzR2V0IiwiZ2V0UmVzcG9uc2VPYmplY3QiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsInRvSlNPTiIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImVycm9yIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImlkIiwibG9nVHJpZ2dlckFmdGVySG9vayIsImlucHV0IiwiY2xlYW5JbnB1dCIsImxvZ2dlciIsInRydW5jYXRlTG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpbmZvIiwibG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rIiwicmVzdWx0IiwiY2xlYW5SZXN1bHQiLCJsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rIiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwiUHJvbWlzZSIsInRyaWdnZXIiLCJmcm9tSlNPTiIsInRyYWNlUHJvbWlzZSIsInRoZW4iLCJyZXN1bHRzIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsInBhcnNlUXVlcnkiLCJRdWVyeSIsIl93aGVyZSIsImluY2x1ZGUiLCJsZW5ndGgiLCJfaW5jbHVkZSIsInNraXAiLCJfc2tpcCIsImxpbWl0IiwiX2xpbWl0IiwicmVxdWVzdE9iamVjdCIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5Iiwid2hlcmUiLCJvcmRlciIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsImVyciIsIm1heWJlUnVuVHJpZ2dlciIsInByb21pc2UiLCJpbmZsYXRlIiwiZGF0YSIsInJlc3RPYmplY3QiLCJjb3B5IiwicnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyIsInBhcmVudCIsImdldFNlZ21lbnQiLCJjYXB0dXJlQXN5bmNGdW5jIiwic3Vic2VnbWVudCIsImFkZEFubm90YXRpb24iLCJjbG9zZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFHQTs7QUFDQTs7OztBQUpBO0FBQ0EsTUFBTUEsT0FBTyxHQUFHQyxPQUFPLENBQUMsY0FBRCxDQUF2Qjs7QUFLTyxNQUFNQyxLQUFLLEdBQUc7QUFDbkJDLEVBQUFBLFdBQVcsRUFBRSxhQURNO0FBRW5CQyxFQUFBQSxVQUFVLEVBQUUsWUFGTztBQUduQkMsRUFBQUEsU0FBUyxFQUFFLFdBSFE7QUFJbkJDLEVBQUFBLFlBQVksRUFBRSxjQUpLO0FBS25CQyxFQUFBQSxXQUFXLEVBQUUsYUFMTTtBQU1uQkMsRUFBQUEsVUFBVSxFQUFFLFlBTk87QUFPbkJDLEVBQUFBLFNBQVMsRUFBRTtBQVBRLENBQWQ7OztBQVVQLE1BQU1DLFNBQVMsR0FBRyxZQUFXO0FBQzNCLFFBQU1DLFVBQVUsR0FBRyxFQUFuQjtBQUNBLFFBQU1DLFNBQVMsR0FBRyxFQUFsQjtBQUNBLFFBQU1DLElBQUksR0FBRyxFQUFiO0FBQ0EsUUFBTUMsU0FBUyxHQUFHLEVBQWxCO0FBQ0EsUUFBTUMsUUFBUSxHQUFHQyxNQUFNLENBQUNDLElBQVAsQ0FBWWYsS0FBWixFQUFtQmdCLE1BQW5CLENBQTBCLFVBQVNDLElBQVQsRUFBZUMsR0FBZixFQUFvQjtBQUM3REQsSUFBQUEsSUFBSSxDQUFDQyxHQUFELENBQUosR0FBWSxFQUFaO0FBQ0EsV0FBT0QsSUFBUDtBQUNELEdBSGdCLEVB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V1NYUmF5ID0gcmVxdWlyZSgnYXdzLXhyYXktc2RrJyk7XG5cbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4vbG9nZ2VyJztcblxuZXhwb3J0IGNvbnN0IFR5cGVzID0ge1xuICBiZWZvcmVMb2dpbjogJ2JlZm9yZUxvZ2luJyxcbiAgYmVmb3JlU2F2ZTogJ2JlZm9yZVNhdmUnLFxuICBhZnRlclNhdmU6ICdhZnRlclNhdmUnLFxuICBiZWZvcmVEZWxldGU6ICdiZWZvcmVEZWxldGUnLFxuICBhZnRlckRlbGV0ZTogJ2FmdGVyRGVsZXRlJyxcbiAgYmVmb3JlRmluZDogJ2JlZm9yZUZpbmQnLFxuICBhZnRlckZpbmQ6ICdhZnRlckZpbmQnLFxufTtcblxuY29uc3QgYmFzZVN0b3JlID0gZnVuY3Rpb24oKSB7XG4gIGNvbnN0IFZhbGlkYXRvcnMgPSB7fTtcbiAgY29uc3QgRnVuY3Rpb25zID0ge307XG4gIGNvbnN0IEpvYnMgPSB7fTtcbiAgY29uc3QgTGl2ZVF1ZXJ5ID0gW107XG4gIGNvbnN0IFRyaWdnZXJzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbihiYXNlLCBrZXkpIHtcbiAgICBiYXNlW2tleV0gPSB7fTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwge30pO1xuXG4gIHJldHVybiBPYmplY3QuZnJlZXplKHtcbiAgICBGdW5jdGlvbnMsXG4gICAgSm9icyxcbiAgICBWYWxpZGF0b3JzLFxuICAgIFRyaWdnZXJzLFxuICAgIExpdmVRdWVyeSxcbiAgfSk7XG59O1xuXG5mdW5jdGlvbiB2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzKGNsYXNzTmFtZSwgdHlwZSkge1xuICBjb25zdCByZXN0cmljdGVkQ2xhc3NOYW1lcyA9IFsnX1Nlc3Npb24nXTtcbiAgaWYgKHJlc3RyaWN0ZWRDbGFzc05hbWVzLmluZGV4T2YoY2xhc3NOYW1lKSAhPSAtMSkge1xuICAgIHRocm93IGBUcmlnZ2VycyBhcmUgbm90IHN1cHBvcnRlZCBmb3IgJHtjbGFzc05hbWV9IGNsYXNzLmA7XG4gIH1cbiAgaWYgKHR5cGUgPT0gVHlwZXMuYmVmb3JlU2F2ZSAmJiBjbGFzc05hbWUgPT09ICdfUHVzaFN0YXR1cycpIHtcbiAgICAvLyBfUHVzaFN0YXR1cyB1c2VzIHVuZG9jdW1lbnRlZCBuZXN0ZWQga2V5IGluY3JlbWVudCBvcHNcbiAgICAvLyBhbGxvd2luZyBiZWZvcmVTYXZlIHdvdWxkIG1lc3MgdXAgdGhlIG9iamVjdHMgYmlnIHRpbWVcbiAgICAvLyBUT0RPOiBBbGxvdyBwcm9wZXIgZG9jdW1lbnRlZCB3YXkgb2YgdXNpbmcgbmVzdGVkIGluY3JlbWVudCBvcHNcbiAgICB0aHJvdyAnT25seSBhZnRlclNhdmUgaXMgYWxsb3dlZCBvbiBfUHVzaFN0YXR1cyc7XG4gIH1cbiAgaWYgKHR5cGUgPT09IFR5cGVzLmJlZm9yZUxvZ2luICYmIGNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgX1VzZXIgY2xhc3MgaXMgYWxsb3dlZCBmb3IgdGhlIGJlZm9yZUxvZ2luIHRyaWdnZXInO1xuICB9XG4gIHJldHVybiBjbGFzc05hbWU7XG59XG5cbmNvbnN0IF90cmlnZ2VyU3RvcmUgPSB7fTtcblxuY29uc3QgQ2F0ZWdvcnkgPSB7XG4gIEZ1bmN0aW9uczogJ0Z1bmN0aW9ucycsXG4gIFZhbGlkYXRvcnM6ICdWYWxpZGF0b3JzJyxcbiAgSm9iczogJ0pvYnMnLFxuICBUcmlnZ2VyczogJ1RyaWdnZXJzJyxcbn07XG5cbmZ1bmN0aW9uIGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IHBhdGggPSBuYW1lLnNwbGl0KCcuJyk7XG4gIHBhdGguc3BsaWNlKC0xKTsgLy8gcmVtb3ZlIGxhc3QgY29tcG9uZW50XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBsZXQgc3RvcmUgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW2NhdGVnb3J5XTtcbiAgZm9yIChjb25zdCBjb21wb25lbnQgb2YgcGF0aCkge1xuICAgIHN0b3JlID0gc3RvcmVbY29tcG9uZW50XTtcbiAgICBpZiAoIXN0b3JlKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RvcmU7XG59XG5cbmZ1bmN0aW9uIGFkZChjYXRlZ29yeSwgbmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBzdG9yZVtsYXN0Q29tcG9uZW50XSA9IGhhbmRsZXI7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBkZWxldGUgc3RvcmVbbGFzdENvbXBvbmVudF07XG59XG5cbmZ1bmN0aW9uIGdldChjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICByZXR1cm4gc3RvcmVbbGFzdENvbXBvbmVudF07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRGdW5jdGlvbihcbiAgZnVuY3Rpb25OYW1lLFxuICBoYW5kbGVyLFxuICB2YWxpZGF0aW9uSGFuZGxlcixcbiAgYXBwbGljYXRpb25JZFxuKSB7XG4gIGFkZChDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG4gIGFkZChDYXRlZ29yeS5WYWxpZGF0b3JzLCBmdW5jdGlvbk5hbWUsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEpvYihqb2JOYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGFkZChDYXRlZ29yeS5Kb2JzLCBqb2JOYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZFRyaWdnZXIodHlwZSwgY2xhc3NOYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKTtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke2NsYXNzTmFtZX1gLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZExpdmVRdWVyeUV2ZW50SGFuZGxlcihoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5wdXNoKGhhbmRsZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZW1vdmUoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3VucmVnaXN0ZXJBbGwoKSB7XG4gIE9iamVjdC5rZXlzKF90cmlnZ2VyU3RvcmUpLmZvckVhY2goYXBwSWQgPT4gZGVsZXRlIF90cmlnZ2VyU3RvcmVbYXBwSWRdKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgYXBwbGljYXRpb25JZCkge1xuICBpZiAoIWFwcGxpY2F0aW9uSWQpIHtcbiAgICB0aHJvdyAnTWlzc2luZyBBcHBsaWNhdGlvbklEJztcbiAgfVxuICByZXR1cm4gZ2V0KENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0cmlnZ2VyRXhpc3RzKFxuICBjbGFzc05hbWU6IHN0cmluZyxcbiAgdHlwZTogc3RyaW5nLFxuICBhcHBsaWNhdGlvbklkOiBzdHJpbmdcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHR5cGUsIGFwcGxpY2F0aW9uSWQpICE9IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEZ1bmN0aW9uTmFtZXMoYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBzdG9yZSA9XG4gICAgKF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gJiZcbiAgICAgIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bQ2F0ZWdvcnkuRnVuY3Rpb25zXSkgfHxcbiAgICB7fTtcbiAgY29uc3QgZnVuY3Rpb25OYW1lcyA9IFtdO1xuICBjb25zdCBleHRyYWN0RnVuY3Rpb25OYW1lcyA9IChuYW1lc3BhY2UsIHN0b3JlKSA9PiB7XG4gICAgT2JqZWN0LmtleXMoc3RvcmUpLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHN0b3JlW25hbWVdO1xuICAgICAgaWYgKG5hbWVzcGFjZSkge1xuICAgICAgICBuYW1lID0gYCR7bmFtZXNwYWNlfS4ke25hbWV9YDtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lcy5wdXNoKG5hbWUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXh0cmFjdEZ1bmN0aW9uTmFtZXMobmFtZSwgdmFsdWUpO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuICBleHRyYWN0RnVuY3Rpb25OYW1lcyhudWxsLCBzdG9yZSk7XG4gIHJldHVybiBmdW5jdGlvbk5hbWVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Sm9iKGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5Kb2JzLCBqb2JOYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEpvYnMoYXBwbGljYXRpb25JZCkge1xuICB2YXIgbWFuYWdlciA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF07XG4gIGlmIChtYW5hZ2VyICYmIG1hbmFnZXIuSm9icykge1xuICAgIHJldHVybiBtYW5hZ2VyLkpvYnM7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFZhbGlkYXRvcihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5WYWxpZGF0b3JzLCBmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdE9iamVjdChcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBvYmplY3Q6IHBhcnNlT2JqZWN0LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICB9O1xuXG4gIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgcmVxdWVzdC5vcmlnaW5hbCA9IG9yaWdpbmFsUGFyc2VPYmplY3Q7XG4gIH1cblxuICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHwgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgIC8vIFNldCBhIGNvcHkgb2YgdGhlIGNvbnRleHQgb24gdGhlIHJlcXVlc3Qgb2JqZWN0LlxuICAgIHJlcXVlc3QuY29udGV4dCA9IE9iamVjdC5hc3NpZ24oe30sIGNvbnRleHQpO1xuICB9XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0KFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgcXVlcnksXG4gIGNvdW50LFxuICBjb25maWcsXG4gIGlzR2V0XG4pIHtcbiAgaXNHZXQgPSAhIWlzR2V0O1xuXG4gIHZhciByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBxdWVyeSxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGNvdW50LFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaXNHZXQsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbi8vIENyZWF0ZXMgdGhlIHJlc3BvbnNlIG9iamVjdCwgYW5kIHVzZXMgdGhlIHJlcXVlc3Qgb2JqZWN0IHRvIHBhc3MgZGF0YVxuLy8gVGhlIEFQSSB3aWxsIGNhbGwgdGhpcyB3aXRoIFJFU1QgQVBJIGZvcm1hdHRlZCBvYmplY3RzLCB0aGlzIHdpbGxcbi8vIHRyYW5zZm9ybSB0aGVtIHRvIFBhcnNlLk9iamVjdCBpbnN0YW5jZXMgZXhwZWN0ZWQgYnkgQ2xvdWQgQ29kZS5cbi8vIEFueSBjaGFuZ2VzIG1hZGUgdG8gdGhlIG9iamVjdCBpbiBhIGJlZm9yZVNhdmUgd2lsbCBiZSBpbmNsdWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXNwb25zZU9iamVjdChyZXF1ZXN0LCByZXNvbHZlLCByZWplY3QpIHtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiBmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyRmluZCkge1xuICAgICAgICBpZiAoIXJlc3BvbnNlKSB7XG4gICAgICAgICAgcmVzcG9uc2UgPSByZXF1ZXN0Lm9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmVzcG9uc2UgPSByZXNwb25zZS5tYXAob2JqZWN0ID0+IHtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0LnRvSlNPTigpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgLy8gVXNlIHRoZSBKU09OIHJlc3BvbnNlXG4gICAgICBpZiAoXG4gICAgICAgIHJlc3BvbnNlICYmXG4gICAgICAgIHR5cGVvZiByZXNwb25zZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgIXJlcXVlc3Qub2JqZWN0LmVxdWFscyhyZXNwb25zZSkgJiZcbiAgICAgICAgcmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgcmVzcG9uc2UgJiZcbiAgICAgICAgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJlxuICAgICAgICByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmVcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKCk7XG4gICAgICB9XG4gICAgICByZXNwb25zZSA9IHt9O1xuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgcmVzcG9uc2VbJ29iamVjdCddID0gcmVxdWVzdC5vYmplY3QuX2dldFNhdmVKU09OKCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgfSxcbiAgICBlcnJvcjogZnVuY3Rpb24oZXJyb3IpIHtcbiAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9IGVsc2UgaWYgKGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICAgICAgcmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELCBlcnJvci5tZXNzYWdlKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsIGVycm9yKSk7XG4gICAgICB9XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdXNlcklkRm9yTG9nKGF1dGgpIHtcbiAgcmV0dXJuIGF1dGggJiYgYXV0aC51c2VyID8gYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGxvZ2dlci5pbmZvKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgdHJpZ2dlclR5cGUsXG4gIGNsYXNzTmFtZSxcbiAgaW5wdXQsXG4gIHJlc3VsdCxcbiAgYXV0aFxuKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGNvbnN0IGNsZWFuUmVzdWx0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShyZXN1bHQpKTtcbiAgbG9nZ2VyLmluZm8oXG4gICAgYCR7dHJpZ2dlclR5cGV9IHRyaWdnZXJlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OlxcbiAgSW5wdXQ6ICR7Y2xlYW5JbnB1dH1cXG4gIFJlc3VsdDogJHtjbGVhblJlc3VsdH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgZXJyb3IpIHtcbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgbG9nZ2VyLmVycm9yKFxuICAgIGAke3RyaWdnZXJUeXBlfSBmYWlsZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9XFxuICBFcnJvcjogJHtKU09OLnN0cmluZ2lmeShlcnJvcil9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGVycm9yLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgb2JqZWN0cyxcbiAgY29uZmlnXG4pIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gICAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgICByZXR1cm4gcmVzb2x2ZSgpO1xuICAgIH1cbiAgICBjb25zdCByZXF1ZXN0ID0gZ2V0UmVxdWVzdE9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgbnVsbCwgbnVsbCwgY29uZmlnKTtcbiAgICBjb25zdCB7IHN1Y2Nlc3MsIGVycm9yIH0gPSBnZXRSZXNwb25zZU9iamVjdChcbiAgICAgIHJlcXVlc3QsXG4gICAgICBvYmplY3QgPT4ge1xuICAgICAgICByZXNvbHZlKG9iamVjdCk7XG4gICAgICB9LFxuICAgICAgZXJyb3IgPT4ge1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfVxuICAgICk7XG4gICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICAnQWZ0ZXJGaW5kJyxcbiAgICAgIEpTT04uc3RyaW5naWZ5KG9iamVjdHMpLFxuICAgICAgYXV0aFxuICAgICk7XG4gICAgcmVxdWVzdC5vYmplY3RzID0gb2JqZWN0cy5tYXAob2JqZWN0ID0+IHtcbiAgICAgIC8vc2V0dGluZyB0aGUgY2xhc3MgbmFtZSB0byB0cmFuc2Zvcm0gaW50byBwYXJzZSBvYmplY3RcbiAgICAgIG9iamVjdC5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gICAgICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKG9iamVjdCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgICAgICBpZiAocmVzcG9uc2UgJiYgdHlwZW9mIHJlc3BvbnNlLnRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHJldHVybiByZXNwb25zZS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgICBpZiAoIXJlc3VsdHMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICAgICAgICAgICAgJ0FmdGVyRmluZCBleHBlY3QgcmVzdWx0cyB0byBiZSByZXR1cm5lZCBpbiB0aGUgcHJvbWlzZSdcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oc3VjY2VzcywgZXJyb3IpXG4gICAgKTtcbiAgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIEpTT04uc3RyaW5naWZ5KHJlc3VsdHMpLCBhdXRoKTtcbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blF1ZXJ5VHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlLFxuICByZXN0T3B0aW9ucyxcbiAgY29uZmlnLFxuICBhdXRoLFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICByZXN0V2hlcmUsXG4gICAgICByZXN0T3B0aW9ucyxcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IHBhcnNlUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lKTtcbiAgaWYgKHJlc3RXaGVyZSkge1xuICAgIHBhcnNlUXVlcnkuX3doZXJlID0gcmVzdFdoZXJlO1xuICB9XG4gIGxldCBjb3VudCA9IGZhbHNlO1xuICBpZiAocmVzdE9wdGlvbnMpIHtcbiAgICBpZiAocmVzdE9wdGlvbnMuaW5jbHVkZSAmJiByZXN0T3B0aW9ucy5pbmNsdWRlLmxlbmd0aCA+IDApIHtcbiAgICAgIHBhcnNlUXVlcnkuX2luY2x1ZGUgPSByZXN0T3B0aW9ucy5pbmNsdWRlLnNwbGl0KCcsJyk7XG4gICAgfVxuICAgIGlmIChyZXN0T3B0aW9ucy5za2lwKSB7XG4gICAgICBwYXJzZVF1ZXJ5Ll9za2lwID0gcmVzdE9wdGlvbnMuc2tpcDtcbiAgICB9XG4gICAgaWYgKHJlc3RPcHRpb25zLmxpbWl0KSB7XG4gICAgICBwYXJzZVF1ZXJ5Ll9saW1pdCA9IHJlc3RPcHRpb25zLmxpbWl0O1xuICAgIH1cbiAgICBjb3VudCA9ICEhcmVzdE9wdGlvbnMuY291bnQ7XG4gIH1cbiAgY29uc3QgcmVxdWVzdE9iamVjdCA9IGdldFJlcXVlc3RRdWVyeU9iamVjdChcbiAgICB0cmlnZ2VyVHlwZSxcbiAgICBhdXRoLFxuICAgIHBhcnNlUXVlcnksXG4gICAgY291bnQsXG4gICAgY29uZmlnLFxuICAgIGlzR2V0XG4gICk7XG4gIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgY2xhc3NOYW1lLFxuICAgIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiB0cmlnZ2VyKHJlcXVlc3RPYmplY3QpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKFxuICAgICAgICByZXN1bHQgPT4ge1xuICAgICAgICAgIGxldCBxdWVyeVJlc3VsdCA9IHBhcnNlUXVlcnk7XG4gICAgICAgICAgaWYgKHJlc3VsdCAmJiByZXN1bHQgaW5zdGFuY2VvZiBQYXJzZS5RdWVyeSkge1xuICAgICAgICAgICAgcXVlcnlSZXN1bHQgPSByZXN1bHQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IGpzb25RdWVyeSA9IHF1ZXJ5UmVzdWx0LnRvSlNPTigpO1xuICAgICAgICAgIGlmIChqc29uUXVlcnkud2hlcmUpIHtcbiAgICAgICAgICAgIHJlc3RXaGVyZSA9IGpzb25RdWVyeS53aGVyZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5saW1pdCkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLmxpbWl0ID0ganNvblF1ZXJ5LmxpbWl0O1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LnNraXApIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5za2lwID0ganNvblF1ZXJ5LnNraXA7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkuaW5jbHVkZSkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgPSBqc29uUXVlcnkuaW5jbHVkZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5rZXlzKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMua2V5cyA9IGpzb25RdWVyeS5rZXlzO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5Lm9yZGVyKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMub3JkZXIgPSBqc29uUXVlcnkub3JkZXI7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UgPVxuICAgICAgICAgICAgICByZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPVxuICAgICAgICAgICAgICByZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICByZXN0V2hlcmUsXG4gICAgICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgICB9O1xuICAgICAgICB9LFxuICAgICAgICBlcnIgPT4ge1xuICAgICAgICAgIGlmICh0eXBlb2YgZXJyID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEsIGVycik7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIClcbiAgKTtcbn1cblxuLy8gVG8gYmUgdXNlZCBhcyBwYXJ0IG9mIHRoZSBwcm9taXNlIGNoYWluIHdoZW4gc2F2aW5nL2RlbGV0aW5nIGFuIG9iamVjdFxuLy8gV2lsbCByZXNvbHZlIHN1Y2Nlc3NmdWxseSBpZiBubyB0cmlnZ2VyIGlzIGNvbmZpZ3VyZWRcbi8vIFJlc29sdmVzIHRvIGFuIG9iamVjdCwgZW1wdHkgb3IgY29udGFpbmluZyBhbiBvYmplY3Qga2V5LiBBIGJlZm9yZVNhdmVcbi8vIHRyaWdnZXIgd2lsbCBzZXQgdGhlIG9iamVjdCBrZXkgdG8gdGhlIHJlc3QgZm9ybWF0IG9iamVjdCB0byBzYXZlLlxuLy8gb3JpZ2luYWxQYXJzZU9iamVjdCBpcyBvcHRpb25hbCwgd2Ugb25seSBuZWVkIHRoYXQgZm9yIGJlZm9yZS9hZnRlclNhdmUgZnVuY3Rpb25zXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5UcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgcGFyc2VPYmplY3QsXG4gIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gIGNvbmZpZyxcbiAgY29udGV4dFxuKSB7XG4gIGlmICghcGFyc2VPYmplY3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIHRyaWdnZXIgPSBnZXRUcmlnZ2VyKFxuICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBjb25maWcuYXBwbGljYXRpb25JZFxuICAgICk7XG4gICAgaWYgKCF0cmlnZ2VyKSByZXR1cm4gcmVzb2x2ZSgpO1xuICAgIHZhciByZXF1ZXN0ID0gZ2V0UmVxdWVzdE9iamVjdChcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgYXV0aCxcbiAgICAgIHBhcnNlT2JqZWN0LFxuICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgICAgIGNvbmZpZyxcbiAgICAgIGNvbnRleHRcbiAgICApO1xuICAgIHZhciB7IHN1Y2Nlc3MsIGVycm9yIH0gPSBnZXRSZXNwb25zZU9iamVjdChcbiAgICAgIHJlcXVlc3QsXG4gICAgICBvYmplY3QgPT4ge1xuICAgICAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICBhdXRoXG4gICAgICAgICk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmVcbiAgICAgICAgKSB7XG4gICAgICAgICAgT2JqZWN0LmFzc2lnbihjb250ZXh0LCByZXF1ZXN0LmNvbnRleHQpO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUob2JqZWN0KTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgZXJyb3JcbiAgICAgICAgKTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gQWZ0ZXJTYXZlIGFuZCBhZnRlckRlbGV0ZSB0cmlnZ2VycyBjYW4gcmV0dXJuIGEgcHJvbWlzZSwgd2hpY2ggaWYgdGhleVxuICAgIC8vIGRvLCBuZWVkcyB0byBiZSByZXNvbHZlZCBiZWZvcmUgdGhpcyBwcm9taXNlIGlzIHJlc29sdmVkLFxuICAgIC8vIHNvIHRyaWdnZXIgZXhlY3V0aW9uIGlzIHN5bmNlZCB3aXRoIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICAvLyBJZiB0cmlnZ2VycyBkbyBub3QgcmV0dXJuIGEgcHJvbWlzZSwgdGhleSBjYW4gcnVuIGFzeW5jIGNvZGUgcGFyYWxsZWxcbiAgICAvLyB0byB0aGUgUmVzdFdyaXRlLmV4ZWN1dGUoKSBjYWxsLlxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBjb25zdCBwcm9taXNlID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJEZWxldGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgbG9nVHJpZ2dlckFmdGVySG9vayhcbiAgICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgICBhdXRoXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBiZWZvcmVTYXZlIGlzIGV4cGVjdGVkIHRvIHJldHVybiBudWxsIChub3RoaW5nKVxuICAgICAgICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgICBpZiAocHJvbWlzZSAmJiB0eXBlb2YgcHJvbWlzZS50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gcHJvbWlzZS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVzcG9uc2Uub2JqZWN0IG1heSBjb21lIGZyb20gZXhwcmVzcyByb3V0aW5nIGJlZm9yZSBob29rXG4gICAgICAgICAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pO1xufVxuXG4vLyBDb252ZXJ0cyBhIFJFU1QtZm9ybWF0IG9iamVjdCB0byBhIFBhcnNlLk9iamVjdFxuLy8gZGF0YSBpcyBlaXRoZXIgY2xhc3NOYW1lIG9yIGFuIG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIGluZmxhdGUoZGF0YSwgcmVzdE9iamVjdCkge1xuICB2YXIgY29weSA9IHR5cGVvZiBkYXRhID09ICdvYmplY3QnID8gZGF0YSA6IHsgY2xhc3NOYW1lOiBkYXRhIH07XG4gIGZvciAodmFyIGtleSBpbiByZXN0T2JqZWN0KSB7XG4gICAgY29weVtrZXldID0gcmVzdE9iamVjdFtrZXldO1xuICB9XG4gIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04oY29weSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKFxuICBkYXRhLFxuICBhcHBsaWNhdGlvbklkID0gUGFyc2UuYXBwbGljYXRpb25JZFxuKSB7XG4gIGlmIChcbiAgICAhX3RyaWdnZXJTdG9yZSB8fFxuICAgICFfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8XG4gICAgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5XG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5mb3JFYWNoKGhhbmRsZXIgPT4gaGFuZGxlcihkYXRhKSk7XG59XG5cbmZ1bmN0aW9uIHRyYWNlUHJvbWlzZSh0eXBlLCBjbGFzc05hbWUsIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKSkge1xuICBjb25zdCBwYXJlbnQgPSBBV1NYUmF5LmdldFNlZ21lbnQoKTtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIEFXU1hSYXkuY2FwdHVyZUFzeW5jRnVuYygnUGFyc2UtU2VydmVyJywgc3Vic2VnbWVudCA9PiB7XG4gICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ29udHJvbGxlcicsICd0cmlnZ2VycycpO1xuICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ1R5cGUnLCB0eXBlKTtcbiAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDbGFzc05hbWUnLCBjbGFzc05hbWUpO1xuICAgICAgcHJvbWlzZS50aGVuKFxuICAgICAgICBmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgIH0sXG4gICAgICAgIGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuY2xvc2UoZXJyb3IpO1xuICAgICAgICB9XG4gICAgICApO1xuICAgIH0pO1xuICB9KTtcbn1cbiJdfQ==