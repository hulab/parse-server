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
const AWSXRay = require('hulab-xray-sdk');

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
      (promise instanceof Promise ? promise : Promise.resolve(promise)).then(function (result) {
        resolve(result);
        subsegment && subsegment.close();
      }, function (error) {
        reject(error);
        subsegment && subsegment.close(error);
      });
    });
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJuYW1lcyI6WyJBV1NYUmF5IiwicmVxdWlyZSIsIlR5cGVzIiwiYmVmb3JlTG9naW4iLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmFzZVN0b3JlIiwiVmFsaWRhdG9ycyIsIkZ1bmN0aW9ucyIsIkpvYnMiLCJMaXZlUXVlcnkiLCJUcmlnZ2VycyIsIk9iamVjdCIsImtleXMiLCJyZWR1Y2UiLCJiYXNlIiwia2V5IiwiZnJlZXplIiwidmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyIsImNsYXNzTmFtZSIsInR5cGUiLCJyZXN0cmljdGVkQ2xhc3NOYW1lcyIsImluZGV4T2YiLCJfdHJpZ2dlclN0b3JlIiwiQ2F0ZWdvcnkiLCJnZXRTdG9yZSIsImNhdGVnb3J5IiwibmFtZSIsImFwcGxpY2F0aW9uSWQiLCJwYXRoIiwic3BsaXQiLCJzcGxpY2UiLCJQYXJzZSIsInN0b3JlIiwiY29tcG9uZW50IiwidW5kZWZpbmVkIiwiYWRkIiwiaGFuZGxlciIsImxhc3RDb21wb25lbnQiLCJyZW1vdmUiLCJnZXQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRMaXZlUXVlcnlFdmVudEhhbmRsZXIiLCJwdXNoIiwicmVtb3ZlRnVuY3Rpb24iLCJyZW1vdmVUcmlnZ2VyIiwiX3VucmVnaXN0ZXJBbGwiLCJmb3JFYWNoIiwiYXBwSWQiLCJnZXRUcmlnZ2VyIiwidHJpZ2dlclR5cGUiLCJ0cmlnZ2VyRXhpc3RzIiwiZ2V0RnVuY3Rpb24iLCJnZXRGdW5jdGlvbk5hbWVzIiwiZnVuY3Rpb25OYW1lcyIsImV4dHJhY3RGdW5jdGlvbk5hbWVzIiwibmFtZXNwYWNlIiwidmFsdWUiLCJnZXRKb2IiLCJnZXRKb2JzIiwibWFuYWdlciIsImdldFZhbGlkYXRvciIsImdldFJlcXVlc3RPYmplY3QiLCJhdXRoIiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsInJlcXVlc3QiLCJ0cmlnZ2VyTmFtZSIsIm9iamVjdCIsIm1hc3RlciIsImxvZyIsImxvZ2dlckNvbnRyb2xsZXIiLCJoZWFkZXJzIiwiaXAiLCJvcmlnaW5hbCIsImFzc2lnbiIsImlzTWFzdGVyIiwidXNlciIsImluc3RhbGxhdGlvbklkIiwiZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0IiwicXVlcnkiLCJjb3VudCIsImlzR2V0IiwiZ2V0UmVzcG9uc2VPYmplY3QiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsInRvSlNPTiIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImVycm9yIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImlkIiwibG9nVHJpZ2dlckFmdGVySG9vayIsImlucHV0IiwiY2xlYW5JbnB1dCIsImxvZ2dlciIsInRydW5jYXRlTG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpbmZvIiwibG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rIiwicmVzdWx0IiwiY2xlYW5SZXN1bHQiLCJsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rIiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwiUHJvbWlzZSIsInRyaWdnZXIiLCJmcm9tSlNPTiIsInRyYWNlUHJvbWlzZSIsInRoZW4iLCJyZXN1bHRzIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsInBhcnNlUXVlcnkiLCJRdWVyeSIsIl93aGVyZSIsImluY2x1ZGUiLCJsZW5ndGgiLCJfaW5jbHVkZSIsInNraXAiLCJfc2tpcCIsImxpbWl0IiwiX2xpbWl0IiwicmVxdWVzdE9iamVjdCIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5Iiwid2hlcmUiLCJvcmRlciIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsImVyciIsIm1heWJlUnVuVHJpZ2dlciIsInByb21pc2UiLCJpbmZsYXRlIiwiZGF0YSIsInJlc3RPYmplY3QiLCJjb3B5IiwicnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyIsInBhcmVudCIsImdldFNlZ21lbnQiLCJjYXB0dXJlQXN5bmNGdW5jIiwic3Vic2VnbWVudCIsImFkZEFubm90YXRpb24iLCJjbG9zZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFHQTs7QUFDQTs7OztBQUpBO0FBQ0EsTUFBTUEsT0FBTyxHQUFHQyxPQUFPLENBQUMsZ0JBQUQsQ0FBdkI7O0FBS08sTUFBTUMsS0FBSyxHQUFHO0FBQ25CQyxFQUFBQSxXQUFXLEVBQUUsYUFETTtBQUVuQkMsRUFBQUEsVUFBVSxFQUFFLFlBRk87QUFHbkJDLEVBQUFBLFNBQVMsRUFBRSxXQUhRO0FBSW5CQyxFQUFBQSxZQUFZLEVBQUUsY0FKSztBQUtuQkMsRUFBQUEsV0FBVyxFQUFFLGFBTE07QUFNbkJDLEVBQUFBLFVBQVUsRUFBRSxZQU5PO0FBT25CQyxFQUFBQSxTQUFTLEVBQUU7QUFQUSxDQUFkOzs7QUFVUCxNQUFNQyxTQUFTLEdBQUcsWUFBVztBQUMzQixRQUFNQyxVQUFVLEdBQUcsRUFBbkI7QUFDQSxRQUFNQyxTQUFTLEdBQUcsRUFBbEI7QUFDQSxRQUFNQyxJQUFJLEdBQUcsRUFBYjtBQUNBLFFBQU1DLFNBQVMsR0FBRyxFQUFsQjtBQUNBLFFBQU1DLFFBQVEsR0FBR0MsTUFBTSxDQUFDQyxJQUFQLENBQVlmLEtBQVosRUFBbUJnQixNQUFuQixDQUEwQixVQUFTQyxJQUFULEVBQWVDLEdBQWYsRUFBb0I7QUFDN0RELElBQUFBLElBQUksQ0FBQ0MsR0FBRCxDQUFKLEdBQVksRUFBWjtBQUNBLFdBQU9ELElBQVA7QUFDRCxHQUhnQixF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LEtBQWpCLENBQWQ7QUFDRCxPQVJIO0FBVUQsS0FoQkg7QUFrQkQsR0FuQk0sQ0FBUDtBQW9CRCIsInNvdXJjZXNDb250ZW50IjpbIi8vIHRyaWdnZXJzLmpzXG5jb25zdCBBV1NYUmF5ID0gcmVxdWlyZSgnaHVsYWIteHJheS1zZGsnKTtcblxuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSAnLi9sb2dnZXInO1xuXG5leHBvcnQgY29uc3QgVHlwZXMgPSB7XG4gIGJlZm9yZUxvZ2luOiAnYmVmb3JlTG9naW4nLFxuICBiZWZvcmVTYXZlOiAnYmVmb3JlU2F2ZScsXG4gIGFmdGVyU2F2ZTogJ2FmdGVyU2F2ZScsXG4gIGJlZm9yZURlbGV0ZTogJ2JlZm9yZURlbGV0ZScsXG4gIGFmdGVyRGVsZXRlOiAnYWZ0ZXJEZWxldGUnLFxuICBiZWZvcmVGaW5kOiAnYmVmb3JlRmluZCcsXG4gIGFmdGVyRmluZDogJ2FmdGVyRmluZCcsXG59O1xuXG5jb25zdCBiYXNlU3RvcmUgPSBmdW5jdGlvbigpIHtcbiAgY29uc3QgVmFsaWRhdG9ycyA9IHt9O1xuICBjb25zdCBGdW5jdGlvbnMgPSB7fTtcbiAgY29uc3QgSm9icyA9IHt9O1xuICBjb25zdCBMaXZlUXVlcnkgPSBbXTtcbiAgY29uc3QgVHJpZ2dlcnMgPSBPYmplY3Qua2V5cyhUeXBlcykucmVkdWNlKGZ1bmN0aW9uKGJhc2UsIGtleSkge1xuICAgIGJhc2Vba2V5XSA9IHt9O1xuICAgIHJldHVybiBiYXNlO1xuICB9LCB7fSk7XG5cbiAgcmV0dXJuIE9iamVjdC5mcmVlemUoe1xuICAgIEZ1bmN0aW9ucyxcbiAgICBKb2JzLFxuICAgIFZhbGlkYXRvcnMsXG4gICAgVHJpZ2dlcnMsXG4gICAgTGl2ZVF1ZXJ5LFxuICB9KTtcbn07XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKSB7XG4gIGNvbnN0IHJlc3RyaWN0ZWRDbGFzc05hbWVzID0gWydfU2Vzc2lvbiddO1xuICBpZiAocmVzdHJpY3RlZENsYXNzTmFtZXMuaW5kZXhPZihjbGFzc05hbWUpICE9IC0xKSB7XG4gICAgdGhyb3cgYFRyaWdnZXJzIGFyZSBub3Qgc3VwcG9ydGVkIGZvciAke2NsYXNzTmFtZX0gY2xhc3MuYDtcbiAgfVxuICBpZiAodHlwZSA9PSBUeXBlcy5iZWZvcmVTYXZlICYmIGNsYXNzTmFtZSA9PT0gJ19QdXNoU3RhdHVzJykge1xuICAgIC8vIF9QdXNoU3RhdHVzIHVzZXMgdW5kb2N1bWVudGVkIG5lc3RlZCBrZXkgaW5jcmVtZW50IG9wc1xuICAgIC8vIGFsbG93aW5nIGJlZm9yZVNhdmUgd291bGQgbWVzcyB1cCB0aGUgb2JqZWN0cyBiaWcgdGltZVxuICAgIC8vIFRPRE86IEFsbG93IHByb3BlciBkb2N1bWVudGVkIHdheSBvZiB1c2luZyBuZXN0ZWQgaW5jcmVtZW50IG9wc1xuICAgIHRocm93ICdPbmx5IGFmdGVyU2F2ZSBpcyBhbGxvd2VkIG9uIF9QdXNoU3RhdHVzJztcbiAgfVxuICBpZiAodHlwZSA9PT0gVHlwZXMuYmVmb3JlTG9naW4gJiYgY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgLy8gVE9ETzogY2hlY2sgaWYgdXBzdHJlYW0gY29kZSB3aWxsIGhhbmRsZSBgRXJyb3JgIGluc3RhbmNlIHJhdGhlclxuICAgIC8vIHRoYW4gdGhpcyBhbnRpLXBhdHRlcm4gb2YgdGhyb3dpbmcgc3RyaW5nc1xuICAgIHRocm93ICdPbmx5IHRoZSBfVXNlciBjbGFzcyBpcyBhbGxvd2VkIGZvciB0aGUgYmVmb3JlTG9naW4gdHJpZ2dlcic7XG4gIH1cbiAgcmV0dXJuIGNsYXNzTmFtZTtcbn1cblxuY29uc3QgX3RyaWdnZXJTdG9yZSA9IHt9O1xuXG5jb25zdCBDYXRlZ29yeSA9IHtcbiAgRnVuY3Rpb25zOiAnRnVuY3Rpb25zJyxcbiAgVmFsaWRhdG9yczogJ1ZhbGlkYXRvcnMnLFxuICBKb2JzOiAnSm9icycsXG4gIFRyaWdnZXJzOiAnVHJpZ2dlcnMnLFxufTtcblxuZnVuY3Rpb24gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgcGF0aCA9IG5hbWUuc3BsaXQoJy4nKTtcbiAgcGF0aC5zcGxpY2UoLTEpOyAvLyByZW1vdmUgbGFzdCBjb21wb25lbnRcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIGxldCBzdG9yZSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bY2F0ZWdvcnldO1xuICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBwYXRoKSB7XG4gICAgc3RvcmUgPSBzdG9yZVtjb21wb25lbnRdO1xuICAgIGlmICghc3RvcmUpIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBzdG9yZTtcbn1cblxuZnVuY3Rpb24gYWRkKGNhdGVnb3J5LCBuYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIHN0b3JlW2xhc3RDb21wb25lbnRdID0gaGFuZGxlcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGRlbGV0ZSBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZnVuY3Rpb24gZ2V0KGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIHJldHVybiBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEZ1bmN0aW9uKFxuICBmdW5jdGlvbk5hbWUsXG4gIGhhbmRsZXIsXG4gIHZhbGlkYXRpb25IYW5kbGVyLFxuICBhcHBsaWNhdGlvbklkXG4pIHtcbiAgYWRkKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkSm9iKGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkVHJpZ2dlcih0eXBlLCBjbGFzc05hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpO1xuICBhZGQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVyKGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LnB1c2goaGFuZGxlcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmVtb3ZlKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVRyaWdnZXIodHlwZSwgY2xhc3NOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfdW5yZWdpc3RlckFsbCgpIHtcbiAgT2JqZWN0LmtleXMoX3RyaWdnZXJTdG9yZSkuZm9yRWFjaChhcHBJZCA9PiBkZWxldGUgX3RyaWdnZXJTdG9yZVthcHBJZF0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBhcHBsaWNhdGlvbklkKSB7XG4gIGlmICghYXBwbGljYXRpb25JZCkge1xuICAgIHRocm93ICdNaXNzaW5nIEFwcGxpY2F0aW9uSUQnO1xuICB9XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRyaWdnZXJFeGlzdHMoXG4gIGNsYXNzTmFtZTogc3RyaW5nLFxuICB0eXBlOiBzdHJpbmcsXG4gIGFwcGxpY2F0aW9uSWQ6IHN0cmluZ1xuKTogYm9vbGVhbiB7XG4gIHJldHVybiBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHlwZSwgYXBwbGljYXRpb25JZCkgIT0gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb25OYW1lcyhhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IHN0b3JlID1cbiAgICAoX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSAmJlxuICAgICAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXVtDYXRlZ29yeS5GdW5jdGlvbnNdKSB8fFxuICAgIHt9O1xuICBjb25zdCBmdW5jdGlvbk5hbWVzID0gW107XG4gIGNvbnN0IGV4dHJhY3RGdW5jdGlvbk5hbWVzID0gKG5hbWVzcGFjZSwgc3RvcmUpID0+IHtcbiAgICBPYmplY3Qua2V5cyhzdG9yZSkuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gc3RvcmVbbmFtZV07XG4gICAgICBpZiAobmFtZXNwYWNlKSB7XG4gICAgICAgIG5hbWUgPSBgJHtuYW1lc3BhY2V9LiR7bmFtZX1gO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBmdW5jdGlvbk5hbWVzLnB1c2gobmFtZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBleHRyYWN0RnVuY3Rpb25OYW1lcyhuYW1lLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG4gIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG51bGwsIHN0b3JlKTtcbiAgcmV0dXJuIGZ1bmN0aW9uTmFtZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2Ioam9iTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Sm9icyhhcHBsaWNhdGlvbklkKSB7XG4gIHZhciBtYW5hZ2VyID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXTtcbiAgaWYgKG1hbmFnZXIgJiYgbWFuYWdlci5Kb2JzKSB7XG4gICAgcmV0dXJuIG1hbmFnZXIuSm9icztcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0T2JqZWN0KFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgcGFyc2VPYmplY3QsXG4gIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gIGNvbmZpZyxcbiAgY29udGV4dFxuKSB7XG4gIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG9iamVjdDogcGFyc2VPYmplY3QsXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gIH07XG5cbiAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICByZXF1ZXN0Lm9yaWdpbmFsID0gb3JpZ2luYWxQYXJzZU9iamVjdDtcbiAgfVxuXG4gIGlmICh0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fCB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlKSB7XG4gICAgLy8gU2V0IGEgY29weSBvZiB0aGUgY29udGV4dCBvbiB0aGUgcmVxdWVzdCBvYmplY3QuXG4gICAgcmVxdWVzdC5jb250ZXh0ID0gT2JqZWN0LmFzc2lnbih7fSwgY29udGV4dCk7XG4gIH1cblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0UXVlcnlPYmplY3QoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBxdWVyeSxcbiAgY291bnQsXG4gIGNvbmZpZyxcbiAgaXNHZXRcbikge1xuICBpc0dldCA9ICEhaXNHZXQ7XG5cbiAgdmFyIHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIHF1ZXJ5LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgY291bnQsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBpc0dldCxcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICB9O1xuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuLy8gQ3JlYXRlcyB0aGUgcmVzcG9uc2Ugb2JqZWN0LCBhbmQgdXNlcyB0aGUgcmVxdWVzdCBvYmplY3QgdG8gcGFzcyBkYXRhXG4vLyBUaGUgQVBJIHdpbGwgY2FsbCB0aGlzIHdpdGggUkVTVCBBUEkgZm9ybWF0dGVkIG9iamVjdHMsIHRoaXMgd2lsbFxuLy8gdHJhbnNmb3JtIHRoZW0gdG8gUGFyc2UuT2JqZWN0IGluc3RhbmNlcyBleHBlY3RlZCBieSBDbG91ZCBDb2RlLlxuLy8gQW55IGNoYW5nZXMgbWFkZSB0byB0aGUgb2JqZWN0IGluIGEgYmVmb3JlU2F2ZSB3aWxsIGJlIGluY2x1ZGVkLlxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlc3BvbnNlT2JqZWN0KHJlcXVlc3QsIHJlc29sdmUsIHJlamVjdCkge1xuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJGaW5kKSB7XG4gICAgICAgIGlmICghcmVzcG9uc2UpIHtcbiAgICAgICAgICByZXNwb25zZSA9IHJlcXVlc3Qub2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICByZXNwb25zZSA9IHJlc3BvbnNlLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIHJldHVybiBvYmplY3QudG9KU09OKCk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICAvLyBVc2UgdGhlIEpTT04gcmVzcG9uc2VcbiAgICAgIGlmIChcbiAgICAgICAgcmVzcG9uc2UgJiZcbiAgICAgICAgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAhcmVxdWVzdC5vYmplY3QuZXF1YWxzKHJlc3BvbnNlKSAmJlxuICAgICAgICByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICByZXNwb25zZSAmJlxuICAgICAgICB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmXG4gICAgICAgIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUoKTtcbiAgICAgIH1cbiAgICAgIHJlc3BvbnNlID0ge307XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSkge1xuICAgICAgICByZXNwb25zZVsnb2JqZWN0J10gPSByZXF1ZXN0Lm9iamVjdC5fZ2V0U2F2ZUpTT04oKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICB9LFxuICAgIGVycm9yOiBmdW5jdGlvbihlcnJvcikge1xuICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IpIHtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH0gZWxzZSBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgICByZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsIGVycm9yLm1lc3NhZ2UpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCwgZXJyb3IpKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiB1c2VySWRGb3JMb2coYXV0aCkge1xuICByZXR1cm4gYXV0aCAmJiBhdXRoLnVzZXIgPyBhdXRoLnVzZXIuaWQgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJBZnRlckhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIGF1dGgpIHtcbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgbG9nZ2VyLmluZm8oXG4gICAgYCR7dHJpZ2dlclR5cGV9IHRyaWdnZXJlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OlxcbiAgSW5wdXQ6ICR7Y2xlYW5JbnB1dH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICB0cmlnZ2VyVHlwZSxcbiAgY2xhc3NOYW1lLFxuICBpbnB1dCxcbiAgcmVzdWx0LFxuICBhdXRoXG4pIHtcbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgY29uc3QgY2xlYW5SZXN1bHQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpO1xuICBsb2dnZXIuaW5mbyhcbiAgICBgJHt0cmlnZ2VyVHlwZX0gdHJpZ2dlcmVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06XFxuICBJbnB1dDogJHtjbGVhbklucHV0fVxcbiAgUmVzdWx0OiAke2NsZWFuUmVzdWx0fWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoLCBlcnJvcikge1xuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBsb2dnZXIuZXJyb3IoXG4gICAgYCR7dHJpZ2dlclR5cGV9IGZhaWxlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OlxcbiAgSW5wdXQ6ICR7Y2xlYW5JbnB1dH1cXG4gIEVycm9yOiAke0pTT04uc3RyaW5naWZ5KGVycm9yKX1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgZXJyb3IsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lLFxuICBvYmplY3RzLFxuICBjb25maWdcbikge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgICBpZiAoIXRyaWdnZXIpIHtcbiAgICAgIHJldHVybiByZXNvbHZlKCk7XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBudWxsLCBudWxsLCBjb25maWcpO1xuICAgIGNvbnN0IHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIHJlc29sdmUob2JqZWN0KTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9XG4gICAgKTtcbiAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgICdBZnRlckZpbmQnLFxuICAgICAgSlNPTi5zdHJpbmdpZnkob2JqZWN0cyksXG4gICAgICBhdXRoXG4gICAgKTtcbiAgICByZXF1ZXN0Lm9iamVjdHMgPSBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgLy9zZXR0aW5nIHRoZSBjbGFzcyBuYW1lIHRvIHRyYW5zZm9ybSBpbnRvIHBhcnNlIG9iamVjdFxuICAgICAgb2JqZWN0LmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04ob2JqZWN0KTtcbiAgICB9KTtcbiAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICAgIGlmIChyZXNwb25zZSAmJiB0eXBlb2YgcmVzcG9uc2UudGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICAgIGlmICghcmVzdWx0cykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgICAgICAgICAgICAnQWZ0ZXJGaW5kIGV4cGVjdCByZXN1bHRzIHRvIGJlIHJldHVybmVkIGluIHRoZSBwcm9taXNlJ1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihzdWNjZXNzLCBlcnJvcilcbiAgICApO1xuICB9KS50aGVuKHJlc3VsdHMgPT4ge1xuICAgIGxvZ1RyaWdnZXJBZnRlckhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgSlNPTi5zdHJpbmdpZnkocmVzdWx0cyksIGF1dGgpO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuUXVlcnlUcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUsXG4gIHJlc3RPcHRpb25zLFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGlzR2V0XG4pIHtcbiAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHtcbiAgICAgIHJlc3RXaGVyZSxcbiAgICAgIHJlc3RPcHRpb25zLFxuICAgIH0pO1xuICB9XG5cbiAgY29uc3QgcGFyc2VRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWUpO1xuICBpZiAocmVzdFdoZXJlKSB7XG4gICAgcGFyc2VRdWVyeS5fd2hlcmUgPSByZXN0V2hlcmU7XG4gIH1cbiAgbGV0IGNvdW50ID0gZmFsc2U7XG4gIGlmIChyZXN0T3B0aW9ucykge1xuICAgIGlmIChyZXN0T3B0aW9ucy5pbmNsdWRlICYmIHJlc3RPcHRpb25zLmluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgICAgcGFyc2VRdWVyeS5faW5jbHVkZSA9IHJlc3RPcHRpb25zLmluY2x1ZGUuc3BsaXQoJywnKTtcbiAgICB9XG4gICAgaWYgKHJlc3RPcHRpb25zLnNraXApIHtcbiAgICAgIHBhcnNlUXVlcnkuX3NraXAgPSByZXN0T3B0aW9ucy5za2lwO1xuICAgIH1cbiAgICBpZiAocmVzdE9wdGlvbnMubGltaXQpIHtcbiAgICAgIHBhcnNlUXVlcnkuX2xpbWl0ID0gcmVzdE9wdGlvbnMubGltaXQ7XG4gICAgfVxuICAgIGNvdW50ID0gISFyZXN0T3B0aW9ucy5jb3VudDtcbiAgfVxuICBjb25zdCByZXF1ZXN0T2JqZWN0ID0gZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0KFxuICAgIHRyaWdnZXJUeXBlLFxuICAgIGF1dGgsXG4gICAgcGFyc2VRdWVyeSxcbiAgICBjb3VudCxcbiAgICBjb25maWcsXG4gICAgaXNHZXRcbiAgKTtcbiAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICB0cmlnZ2VyVHlwZSxcbiAgICBjbGFzc05hbWUsXG4gICAgUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRyaWdnZXIocmVxdWVzdE9iamVjdCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oXG4gICAgICAgIHJlc3VsdCA9PiB7XG4gICAgICAgICAgbGV0IHF1ZXJ5UmVzdWx0ID0gcGFyc2VRdWVyeTtcbiAgICAgICAgICBpZiAocmVzdWx0ICYmIHJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLlF1ZXJ5KSB7XG4gICAgICAgICAgICBxdWVyeVJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QganNvblF1ZXJ5ID0gcXVlcnlSZXN1bHQudG9KU09OKCk7XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS53aGVyZSkge1xuICAgICAgICAgICAgcmVzdFdoZXJlID0ganNvblF1ZXJ5LndoZXJlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LmxpbWl0KSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMubGltaXQgPSBqc29uUXVlcnkubGltaXQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkuc2tpcCkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLnNraXAgPSBqc29uUXVlcnkuc2tpcDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5pbmNsdWRlKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSA9IGpzb25RdWVyeS5pbmNsdWRlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LmtleXMpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5rZXlzID0ganNvblF1ZXJ5LmtleXM7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkub3JkZXIpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5vcmRlciA9IGpzb25RdWVyeS5vcmRlcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9XG4gICAgICAgICAgICAgIHJlcXVlc3RPYmplY3QuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9XG4gICAgICAgICAgICAgIHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHJlc3RXaGVyZSxcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLFxuICAgICAgICAgIH07XG4gICAgICAgIH0sXG4gICAgICAgIGVyciA9PiB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBlcnIgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMSwgZXJyKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgKVxuICApO1xufVxuXG4vLyBUbyBiZSB1c2VkIGFzIHBhcnQgb2YgdGhlIHByb21pc2UgY2hhaW4gd2hlbiBzYXZpbmcvZGVsZXRpbmcgYW4gb2JqZWN0XG4vLyBXaWxsIHJlc29sdmUgc3VjY2Vzc2Z1bGx5IGlmIG5vIHRyaWdnZXIgaXMgY29uZmlndXJlZFxuLy8gUmVzb2x2ZXMgdG8gYW4gb2JqZWN0LCBlbXB0eSBvciBjb250YWluaW5nIGFuIG9iamVjdCBrZXkuIEEgYmVmb3JlU2F2ZVxuLy8gdHJpZ2dlciB3aWxsIHNldCB0aGUgb2JqZWN0IGtleSB0byB0aGUgcmVzdCBmb3JtYXQgb2JqZWN0IHRvIHNhdmUuXG4vLyBvcmlnaW5hbFBhcnNlT2JqZWN0IGlzIG9wdGlvbmFsLCB3ZSBvbmx5IG5lZWQgdGhhdCBmb3IgYmVmb3JlL2FmdGVyU2F2ZSBmdW5jdGlvbnNcbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0XG4pIHtcbiAgaWYgKCFwYXJzZU9iamVjdCkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdHJpZ2dlciA9IGdldFRyaWdnZXIoXG4gICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGNvbmZpZy5hcHBsaWNhdGlvbklkXG4gICAgKTtcbiAgICBpZiAoIXRyaWdnZXIpIHJldHVybiByZXNvbHZlKCk7XG4gICAgdmFyIHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBhdXRoLFxuICAgICAgcGFyc2VPYmplY3QsXG4gICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgY29uZmlnLFxuICAgICAgY29udGV4dFxuICAgICk7XG4gICAgdmFyIHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgb2JqZWN0LFxuICAgICAgICAgIGF1dGhcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZVxuICAgICAgICApIHtcbiAgICAgICAgICBPYmplY3QuYXNzaWduKGNvbnRleHQsIHJlcXVlc3QuY29udGV4dCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZShvYmplY3QpO1xuICAgICAgfSxcbiAgICAgIGVycm9yID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgYXV0aCxcbiAgICAgICAgICBlcnJvclxuICAgICAgICApO1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBBZnRlclNhdmUgYW5kIGFmdGVyRGVsZXRlIHRyaWdnZXJzIGNhbiByZXR1cm4gYSBwcm9taXNlLCB3aGljaCBpZiB0aGV5XG4gICAgLy8gZG8sIG5lZWRzIHRvIGJlIHJlc29sdmVkIGJlZm9yZSB0aGlzIHByb21pc2UgaXMgcmVzb2x2ZWQsXG4gICAgLy8gc28gdHJpZ2dlciBleGVjdXRpb24gaXMgc3luY2VkIHdpdGggUmVzdFdyaXRlLmV4ZWN1dGUoKSBjYWxsLlxuICAgIC8vIElmIHRyaWdnZXJzIGRvIG5vdCByZXR1cm4gYSBwcm9taXNlLCB0aGV5IGNhbiBydW4gYXN5bmMgY29kZSBwYXJhbGxlbFxuICAgIC8vIHRvIHRoZSBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGNvbnN0IHByb21pc2UgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZVxuICAgICAgICApIHtcbiAgICAgICAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKFxuICAgICAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICAgIGF1dGhcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIGJlZm9yZVNhdmUgaXMgZXhwZWN0ZWQgdG8gcmV0dXJuIG51bGwgKG5vdGhpbmcpXG4gICAgICAgIGlmICh0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSkge1xuICAgICAgICAgIGlmIChwcm9taXNlICYmIHR5cGVvZiBwcm9taXNlLnRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHJldHVybiBwcm9taXNlLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICAgICAgICAvLyByZXNwb25zZS5vYmplY3QgbWF5IGNvbWUgZnJvbSBleHByZXNzIHJvdXRpbmcgYmVmb3JlIGhvb2tcbiAgICAgICAgICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLm9iamVjdCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwcm9taXNlO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHN1Y2Nlc3MsIGVycm9yKTtcbiAgfSk7XG59XG5cbi8vIENvbnZlcnRzIGEgUkVTVC1mb3JtYXQgb2JqZWN0IHRvIGEgUGFyc2UuT2JqZWN0XG4vLyBkYXRhIGlzIGVpdGhlciBjbGFzc05hbWUgb3IgYW4gb2JqZWN0XG5leHBvcnQgZnVuY3Rpb24gaW5mbGF0ZShkYXRhLCByZXN0T2JqZWN0KSB7XG4gIHZhciBjb3B5ID0gdHlwZW9mIGRhdGEgPT0gJ29iamVjdCcgPyBkYXRhIDogeyBjbGFzc05hbWU6IGRhdGEgfTtcbiAgZm9yICh2YXIga2V5IGluIHJlc3RPYmplY3QpIHtcbiAgICBjb3B5W2tleV0gPSByZXN0T2JqZWN0W2tleV07XG4gIH1cbiAgcmV0dXJuIFBhcnNlLk9iamVjdC5mcm9tSlNPTihjb3B5KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoXG4gIGRhdGEsXG4gIGFwcGxpY2F0aW9uSWQgPSBQYXJzZS5hcHBsaWNhdGlvbklkXG4pIHtcbiAgaWYgKFxuICAgICFfdHJpZ2dlclN0b3JlIHx8XG4gICAgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHxcbiAgICAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnlcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LmZvckVhY2goaGFuZGxlciA9PiBoYW5kbGVyKGRhdGEpKTtcbn1cblxuZnVuY3Rpb24gdHJhY2VQcm9taXNlKHR5cGUsIGNsYXNzTmFtZSwgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpKSB7XG4gIGNvbnN0IHBhcmVudCA9IEFXU1hSYXkuZ2V0U2VnbWVudCgpO1xuICBpZiAoIXBhcmVudCkge1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgQVdTWFJheS5jYXB0dXJlQXN5bmNGdW5jKFxuICAgICAgYFBhcnNlLVNlcnZlcl90cmlnZ2Vyc18ke3R5cGV9XyR7Y2xhc3NOYW1lfWAsXG4gICAgICBzdWJzZWdtZW50ID0+IHtcbiAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ0NvbnRyb2xsZXInLCAndHJpZ2dlcnMnKTtcbiAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ1R5cGUnLCB0eXBlKTtcbiAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ0NsYXNzTmFtZScsIGNsYXNzTmFtZSk7XG4gICAgICAgIChwcm9taXNlIGluc3RhbmNlb2YgUHJvbWlzZSA/IHByb21pc2UgOiBQcm9taXNlLnJlc29sdmUocHJvbWlzZSkpLnRoZW4oXG4gICAgICAgICAgZnVuY3Rpb24ocmVzdWx0KSB7XG4gICAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuY2xvc2UoKTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKGVycm9yKTtcbiAgICAgICAgICB9XG4gICAgICAgICk7XG4gICAgICB9XG4gICAgKTtcbiAgfSk7XG59XG4iXX0=