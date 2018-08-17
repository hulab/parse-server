'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.Types = undefined;
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

var _node = require('parse/node');

var _node2 = _interopRequireDefault(_node);

var _logger = require('./logger');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// triggers.js
const Types = exports.Types = {
  beforeSave: 'beforeSave',
  afterSave: 'afterSave',
  beforeDelete: 'beforeDelete',
  afterDelete: 'afterDelete',
  beforeFind: 'beforeFind',
  afterFind: 'afterFind'
};

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
  applicationId = applicationId || _node2.default.applicationId;
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
  applicationId = applicationId || _node2.default.applicationId;
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
    throw "Missing ApplicationID";
  }
  return get(Category.Triggers, `${triggerType}.${className}`, applicationId);
}

function triggerExists(className, type, applicationId) {
  return getTrigger(className, type, applicationId) != undefined;
}

function getFunction(functionName, applicationId) {
  return get(Category.Functions, functionName, applicationId);
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
}

// Creates the response object, and uses the request object to pass data
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
      }
      // Use the JSON response
      if (response && !request.object.equals(response) && request.triggerName === Types.beforeSave) {
        return resolve(response);
      }
      response = {};
      if (request.triggerName === Types.beforeSave) {
        response['object'] = request.object._getSaveJSON();
      }
      return resolve(response);
    },
    error: function (error) {
      if (typeof error === 'string') {
        return reject(new _node2.default.Error(_node2.default.Error.SCRIPT_FAILED, error));
      }
      return reject(error);
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
    const { success, error } = getResponseObject(request, object => {
      resolve(object);
    }, error => {
      reject(error);
    });
    logTriggerSuccessBeforeHook(triggerType, className, 'AfterFind', JSON.stringify(objects), auth);
    request.objects = objects.map(object => {
      //setting the class name to transform into parse object
      object.className = className;
      return _node2.default.Object.fromJSON(object);
    });
    return Promise.resolve().then(() => {
      const response = trigger(request);
      if (response && typeof response.then === 'function') {
        return response.then(results => {
          if (!results) {
            throw new _node2.default.Error(_node2.default.Error.SCRIPT_FAILED, "AfterFind expect results to be returned in the promise");
          }
          return results;
        });
      }
      return response;
    }).then(success, error);
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

  const parseQuery = new _node2.default.Query(className);
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
  return Promise.resolve().then(() => {
    return trigger(requestObject);
  }).then(result => {
    let queryResult = parseQuery;
    if (result && result instanceof _node2.default.Query) {
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
      throw new _node2.default.Error(1, err);
    } else {
      throw err;
    }
  });
}

// To be used as part of the promise chain when saving/deleting an object
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
    var { success, error } = getResponseObject(request, object => {
      logTriggerSuccessBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), object, auth);
      if (triggerType === Types.beforeSave || triggerType === Types.afterSave) {
        Object.assign(context, request.context);
      }
      resolve(object);
    }, error => {
      logTriggerErrorBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), auth, error);
      reject(error);
    });

    // AfterSave and afterDelete triggers can return a promise, which if they
    // do, needs to be resolved before this promise is resolved,
    // so trigger execution is synced with RestWrite.execute() call.
    // If triggers do not return a promise, they can run async code parallel
    // to the RestWrite.execute() call.
    return Promise.resolve().then(() => {
      const promise = trigger(request);
      if (triggerType === Types.afterSave || triggerType === Types.afterDelete) {
        logTriggerAfterHook(triggerType, parseObject.className, parseObject.toJSON(), auth);
      }
      return promise;
    }).then(success, error);
  });
}

// Converts a REST-format object to a Parse.Object
// data is either className or an object
function inflate(data, restObject) {
  var copy = typeof data == 'object' ? data : { className: data };
  for (var key in restObject) {
    copy[key] = restObject[key];
  }
  return _node2.default.Object.fromJSON(copy);
}

function runLiveQueryEventHandlers(data, applicationId = _node2.default.applicationId) {
  if (!_triggerStore || !_triggerStore[applicationId] || !_triggerStore[applicationId].LiveQuery) {
    return;
  }
  _triggerStore[applicationId].LiveQuery.forEach(handler => handler(data));
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJuYW1lcyI6WyJhZGRGdW5jdGlvbiIsImFkZEpvYiIsImFkZFRyaWdnZXIiLCJhZGRMaXZlUXVlcnlFdmVudEhhbmRsZXIiLCJyZW1vdmVGdW5jdGlvbiIsInJlbW92ZVRyaWdnZXIiLCJfdW5yZWdpc3RlckFsbCIsImdldFRyaWdnZXIiLCJ0cmlnZ2VyRXhpc3RzIiwiZ2V0RnVuY3Rpb24iLCJnZXRKb2IiLCJnZXRKb2JzIiwiZ2V0VmFsaWRhdG9yIiwiZ2V0UmVxdWVzdE9iamVjdCIsImdldFJlcXVlc3RRdWVyeU9iamVjdCIsImdldFJlc3BvbnNlT2JqZWN0IiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJtYXliZVJ1blRyaWdnZXIiLCJpbmZsYXRlIiwicnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFmdGVyU2F2ZSIsImJlZm9yZURlbGV0ZSIsImFmdGVyRGVsZXRlIiwiYmVmb3JlRmluZCIsImFmdGVyRmluZCIsImJhc2VTdG9yZSIsIlZhbGlkYXRvcnMiLCJGdW5jdGlvbnMiLCJKb2JzIiwiTGl2ZVF1ZXJ5IiwiVHJpZ2dlcnMiLCJPYmplY3QiLCJrZXlzIiwicmVkdWNlIiwiYmFzZSIsImtleSIsImZyZWV6ZSIsInZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMiLCJjbGFzc05hbWUiLCJ0eXBlIiwicmVzdHJpY3RlZENsYXNzTmFtZXMiLCJpbmRleE9mIiwiX3RyaWdnZXJTdG9yZSIsIkNhdGVnb3J5IiwiZ2V0U3RvcmUiLCJjYXRlZ29yeSIsIm5hbWUiLCJhcHBsaWNhdGlvbklkIiwicGF0aCIsInNwbGl0Iiwic3BsaWNlIiwiUGFyc2UiLCJzdG9yZSIsImNvbXBvbmVudCIsInVuZGVmaW5lZCIsImFkZCIsImhhbmRsZXIiLCJsYXN0Q29tcG9uZW50IiwicmVtb3ZlIiwiZ2V0IiwiZnVuY3Rpb25OYW1lIiwidmFsaWRhdGlvbkhhbmRsZXIiLCJqb2JOYW1lIiwicHVzaCIsImZvckVhY2giLCJhcHBJZCIsInRyaWdnZXJUeXBlIiwibWFuYWdlciIsImF1dGgiLCJwYXJzZU9iamVjdCIsIm9yaWdpbmFsUGFyc2VPYmplY3QiLCJjb25maWciLCJjb250ZXh0IiwicmVxdWVzdCIsInRyaWdnZXJOYW1lIiwib2JqZWN0IiwibWFzdGVyIiwibG9nIiwibG9nZ2VyQ29udHJvbGxlciIsImhlYWRlcnMiLCJpcCIsIm9yaWdpbmFsIiwiYXNzaWduIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiaW5zdGFsbGF0aW9uSWQiLCJxdWVyeSIsImNvdW50IiwiaXNHZXQiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsInRvSlNPTiIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImVycm9yIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwidXNlcklkRm9yTG9nIiwiaWQiLCJsb2dUcmlnZ2VyQWZ0ZXJIb29rIiwiaW5wdXQiLCJjbGVhbklucHV0IiwibG9nZ2VyIiwidHJ1bmNhdGVMb2dNZXNzYWdlIiwiSlNPTiIsInN0cmluZ2lmeSIsImluZm8iLCJsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2siLCJyZXN1bHQiLCJjbGVhblJlc3VsdCIsImxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2siLCJQcm9taXNlIiwidHJpZ2dlciIsImZyb21KU09OIiwidGhlbiIsInJlc3VsdHMiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsInBhcnNlUXVlcnkiLCJRdWVyeSIsIl93aGVyZSIsImluY2x1ZGUiLCJsZW5ndGgiLCJfaW5jbHVkZSIsInNraXAiLCJfc2tpcCIsImxpbWl0IiwiX2xpbWl0IiwicmVxdWVzdE9iamVjdCIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5Iiwid2hlcmUiLCJvcmRlciIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJl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QixJQUE5RTtBQUNEO0FBQ0QsYUFBT3lFLE9BQVA7QUFDRCxLQU5NLEVBTUp2QixJQU5JLENBTUMzQixPQU5ELEVBTVVPLEtBTlYsQ0FBUDtBQU9ELEdBN0JNLENBQVA7QUE4QkQ7O0FBRUQ7QUFDQTtBQUNPLFNBQVNsRixPQUFULENBQWlCOEgsSUFBakIsRUFBdUJDLFVBQXZCLEVBQW1DO0FBQ3hDLE1BQUlDLE9BQU8sT0FBT0YsSUFBUCxJQUFlLFFBQWYsR0FBMEJBLElBQTFCLEdBQWlDLEVBQUN4RyxXQUFXd0csSUFBWixFQUE1QztBQUNBLE9BQUssSUFBSTNHLEdBQVQsSUFBZ0I0RyxVQUFoQixFQUE0QjtBQUMxQkMsU0FBSzdHLEdBQUwsSUFBWTRHLFdBQVc1RyxHQUFYLENBQVo7QUFDRDtBQUNELFNBQU9nQixlQUFNcEIsTUFBTixDQUFhc0YsUUFBYixDQUFzQjJCLElBQXRCLENBQVA7QUFDRDs7QUFFTSxTQUFTL0gseUJBQVQsQ0FBbUM2SCxJQUFuQyxFQUF5Qy9GLGdCQUFnQkksZUFBTUosYUFBL0QsRUFBOEU7QUFDbkYsTUFBSSxDQUFDTCxhQUFELElBQWtCLENBQUNBLGNBQWNLLGFBQWQsQ0FBbkIsSUFBbUQsQ0FBQ0wsY0FBY0ssYUFBZCxFQUE2QmxCLFNBQXJGLEVBQWdHO0FBQUU7QUFBUztBQUMzR2EsZ0JBQWNLLGFBQWQsRUFBNkJsQixTQUE3QixDQUF1Q21DLE9BQXZDLENBQWdEUixPQUFELElBQWFBLFFBQVFzRixJQUFSLENBQTVEO0FBQ0QiLCJmaWxlIjoidHJpZ2dlcnMuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyB0cmlnZ2Vycy5qc1xuaW1wb3J0IFBhcnNlICAgIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSAnLi9sb2dnZXInO1xuXG5leHBvcnQgY29uc3QgVHlwZXMgPSB7XG4gIGJlZm9yZVNhdmU6ICdiZWZvcmVTYXZlJyxcbiAgYWZ0ZXJTYXZlOiAnYWZ0ZXJTYXZlJyxcbiAgYmVmb3JlRGVsZXRlOiAnYmVmb3JlRGVsZXRlJyxcbiAgYWZ0ZXJEZWxldGU6ICdhZnRlckRlbGV0ZScsXG4gIGJlZm9yZUZpbmQ6ICdiZWZvcmVGaW5kJyxcbiAgYWZ0ZXJGaW5kOiAnYWZ0ZXJGaW5kJ1xufTtcblxuY29uc3QgYmFzZVN0b3JlID0gZnVuY3Rpb24oKSB7XG4gIGNvbnN0IFZhbGlkYXRvcnMgPSB7fTtcbiAgY29uc3QgRnVuY3Rpb25zID0ge307XG4gIGNvbnN0IEpvYnMgPSB7fTtcbiAgY29uc3QgTGl2ZVF1ZXJ5ID0gW107XG4gIGNvbnN0IFRyaWdnZXJzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbihiYXNlLCBrZXkpe1xuICAgIGJhc2Vba2V5XSA9IHt9O1xuICAgIHJldHVybiBiYXNlO1xuICB9LCB7fSk7XG5cbiAgcmV0dXJuIE9iamVjdC5mcmVlemUoe1xuICAgIEZ1bmN0aW9ucyxcbiAgICBKb2JzLFxuICAgIFZhbGlkYXRvcnMsXG4gICAgVHJpZ2dlcnMsXG4gICAgTGl2ZVF1ZXJ5LFxuICB9KTtcbn07XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKSB7XG4gIGNvbnN0IHJlc3RyaWN0ZWRDbGFzc05hbWVzID0gWyAnX1Nlc3Npb24nIF07XG4gIGlmIChyZXN0cmljdGVkQ2xhc3NOYW1lcy5pbmRleE9mKGNsYXNzTmFtZSkgIT0gLTEpIHtcbiAgICB0aHJvdyBgVHJpZ2dlcnMgYXJlIG5vdCBzdXBwb3J0ZWQgZm9yICR7Y2xhc3NOYW1lfSBjbGFzcy5gO1xuICB9XG4gIGlmICh0eXBlID09IFR5cGVzLmJlZm9yZVNhdmUgJiYgY2xhc3NOYW1lID09PSAnX1B1c2hTdGF0dXMnKSB7XG4gICAgLy8gX1B1c2hTdGF0dXMgdXNlcyB1bmRvY3VtZW50ZWQgbmVzdGVkIGtleSBpbmNyZW1lbnQgb3BzXG4gICAgLy8gYWxsb3dpbmcgYmVmb3JlU2F2ZSB3b3VsZCBtZXNzIHVwIHRoZSBvYmplY3RzIGJpZyB0aW1lXG4gICAgLy8gVE9ETzogQWxsb3cgcHJvcGVyIGRvY3VtZW50ZWQgd2F5IG9mIHVzaW5nIG5lc3RlZCBpbmNyZW1lbnQgb3BzXG4gICAgdGhyb3cgJ09ubHkgYWZ0ZXJTYXZlIGlzIGFsbG93ZWQgb24gX1B1c2hTdGF0dXMnO1xuICB9XG4gIHJldHVybiBjbGFzc05hbWU7XG59XG5cbmNvbnN0IF90cmlnZ2VyU3RvcmUgPSB7fTtcblxuY29uc3QgQ2F0ZWdvcnkgPSB7XG4gIEZ1bmN0aW9uczogJ0Z1bmN0aW9ucycsXG4gIFZhbGlkYXRvcnM6ICdWYWxpZGF0b3JzJyxcbiAgSm9iczogJ0pvYnMnLFxuICBUcmlnZ2VyczogJ1RyaWdnZXJzJ1xufVxuXG5mdW5jdGlvbiBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBwYXRoID0gbmFtZS5zcGxpdCgnLicpO1xuICBwYXRoLnNwbGljZSgtMSk7IC8vIHJlbW92ZSBsYXN0IGNvbXBvbmVudFxuICBhcHBsaWNhdGlvbklkID0gYXBwbGljYXRpb25JZCB8fCBQYXJzZS5hcHBsaWNhdGlvbklkO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdID0gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIGxldCBzdG9yZSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bY2F0ZWdvcnldO1xuICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBwYXRoKSB7XG4gICAgc3RvcmUgPSBzdG9yZVtjb21wb25lbnRdO1xuICAgIGlmICghc3RvcmUpIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBzdG9yZTtcbn1cblxuZnVuY3Rpb24gYWRkKGNhdGVnb3J5LCBuYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIHN0b3JlW2xhc3RDb21wb25lbnRdID0gaGFuZGxlcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGRlbGV0ZSBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZnVuY3Rpb24gZ2V0KGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIHJldHVybiBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgaGFuZGxlciwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkSm9iKGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkVHJpZ2dlcih0eXBlLCBjbGFzc05hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpO1xuICBhZGQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVyKGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9ICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5wdXNoKGhhbmRsZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZW1vdmUoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3VucmVnaXN0ZXJBbGwoKSB7XG4gIE9iamVjdC5rZXlzKF90cmlnZ2VyU3RvcmUpLmZvckVhY2goYXBwSWQgPT4gZGVsZXRlIF90cmlnZ2VyU3RvcmVbYXBwSWRdKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgYXBwbGljYXRpb25JZCkge1xuICBpZiAoIWFwcGxpY2F0aW9uSWQpIHtcbiAgICB0aHJvdyBcIk1pc3NpbmcgQXBwbGljYXRpb25JRFwiO1xuICB9XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRyaWdnZXJFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIHR5cGU6IHN0cmluZywgYXBwbGljYXRpb25JZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAoZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHR5cGUsIGFwcGxpY2F0aW9uSWQpICE9IHVuZGVmaW5lZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2Ioam9iTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Sm9icyhhcHBsaWNhdGlvbklkKSB7XG4gIHZhciBtYW5hZ2VyID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXTtcbiAgaWYgKG1hbmFnZXIgJiYgbWFuYWdlci5Kb2JzKSB7XG4gICAgcmV0dXJuIG1hbmFnZXIuSm9icztcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRWYWxpZGF0b3IoZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIHBhcnNlT2JqZWN0LCBvcmlnaW5hbFBhcnNlT2JqZWN0LCBjb25maWcsIGNvbnRleHQpIHtcbiAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgb2JqZWN0OiBwYXJzZU9iamVjdCxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgfTtcblxuICBpZiAob3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgIHJlcXVlc3Qub3JpZ2luYWwgPSBvcmlnaW5hbFBhcnNlT2JqZWN0O1xuICB9XG5cbiAgaWYgKHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlIHx8IHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAvLyBTZXQgYSBjb3B5IG9mIHRoZSBjb250ZXh0IG9uIHRoZSByZXF1ZXN0IG9iamVjdC5cbiAgICByZXF1ZXN0LmNvbnRleHQgPSBPYmplY3QuYXNzaWduKHt9LCBjb250ZXh0KTtcbiAgfVxuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RRdWVyeU9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgcXVlcnksIGNvdW50LCBjb25maWcsIGlzR2V0KSB7XG4gIGlzR2V0ID0gISFpc0dldDtcblxuICB2YXIgcmVxdWVzdCA9IHtcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgcXVlcnksXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBjb3VudCxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGlzR2V0LFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gIH07XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG4vLyBDcmVhdGVzIHRoZSByZXNwb25zZSBvYmplY3QsIGFuZCB1c2VzIHRoZSByZXF1ZXN0IG9iamVjdCB0byBwYXNzIGRhdGFcbi8vIFRoZSBBUEkgd2lsbCBjYWxsIHRoaXMgd2l0aCBSRVNUIEFQSSBmb3JtYXR0ZWQgb2JqZWN0cywgdGhpcyB3aWxsXG4vLyB0cmFuc2Zvcm0gdGhlbSB0byBQYXJzZS5PYmplY3QgaW5zdGFuY2VzIGV4cGVjdGVkIGJ5IENsb3VkIENvZGUuXG4vLyBBbnkgY2hhbmdlcyBtYWRlIHRvIHRoZSBvYmplY3QgaW4gYSBiZWZvcmVTYXZlIHdpbGwgYmUgaW5jbHVkZWQuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVzcG9uc2VPYmplY3QocmVxdWVzdCwgcmVzb2x2ZSwgcmVqZWN0KSB7XG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlckZpbmQpIHtcbiAgICAgICAgaWYoIXJlc3BvbnNlKXtcbiAgICAgICAgICByZXNwb25zZSA9IHJlcXVlc3Qub2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICByZXNwb25zZSA9IHJlc3BvbnNlLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIHJldHVybiBvYmplY3QudG9KU09OKCk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICAvLyBVc2UgdGhlIEpTT04gcmVzcG9uc2VcbiAgICAgIGlmIChyZXNwb25zZSAmJiAhcmVxdWVzdC5vYmplY3QuZXF1YWxzKHJlc3BvbnNlKVxuICAgICAgICAgICYmIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgcmVzcG9uc2UgPSB7fTtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXSA9IHJlcXVlc3Qub2JqZWN0Ll9nZXRTYXZlSlNPTigpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgIH0sXG4gICAgZXJyb3I6IGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICBpZiAodHlwZW9mIGVycm9yID09PSAnc3RyaW5nJykge1xuICAgICAgICByZXR1cm4gcmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELCBlcnJvcikpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlamVjdChlcnJvcik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHVzZXJJZEZvckxvZyhhdXRoKSB7XG4gIHJldHVybiAoYXV0aCAmJiBhdXRoLnVzZXIpID8gYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGxvZ2dlci5pbmZvKGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhhdXRoKX06XFxuICBJbnB1dDogJHtjbGVhbklucHV0fWAsIHtcbiAgICBjbGFzc05hbWUsXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIHJlc3VsdCwgYXV0aCkge1xuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBjb25zdCBjbGVhblJlc3VsdCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gIGxvZ2dlci5pbmZvKGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhhdXRoKX06XFxuICBJbnB1dDogJHtjbGVhbklucHV0fVxcbiAgUmVzdWx0OiAke2NsZWFuUmVzdWx0fWAsIHtcbiAgICBjbGFzc05hbWUsXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoLCBlcnJvcikge1xuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBsb2dnZXIuZXJyb3IoYCR7dHJpZ2dlclR5cGV9IGZhaWxlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKGF1dGgpfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9XFxuICBFcnJvcjogJHtKU09OLnN0cmluZ2lmeShlcnJvcil9YCwge1xuICAgIGNsYXNzTmFtZSxcbiAgICB0cmlnZ2VyVHlwZSxcbiAgICBlcnJvcixcbiAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aClcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIodHJpZ2dlclR5cGUsIGF1dGgsIGNsYXNzTmFtZSwgb2JqZWN0cywgY29uZmlnKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikge1xuICAgICAgcmV0dXJuIHJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIG51bGwsIG51bGwsIGNvbmZpZyk7XG4gICAgY29uc3QgeyBzdWNjZXNzLCBlcnJvciB9ID0gZ2V0UmVzcG9uc2VPYmplY3QocmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIHJlc29sdmUob2JqZWN0KTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9KTtcbiAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgJ0FmdGVyRmluZCcsIEpTT04uc3RyaW5naWZ5KG9iamVjdHMpLCBhdXRoKTtcbiAgICByZXF1ZXN0Lm9iamVjdHMgPSBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgLy9zZXR0aW5nIHRoZSBjbGFzcyBuYW1lIHRvIHRyYW5zZm9ybSBpbnRvIHBhcnNlIG9iamVjdFxuICAgICAgb2JqZWN0LmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04ob2JqZWN0KTtcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCkudGhlbigoKSA9PiB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IHRyaWdnZXIocmVxdWVzdCk7XG4gICAgICBpZiAocmVzcG9uc2UgJiYgdHlwZW9mIHJlc3BvbnNlLnRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlLnRoZW4oKHJlc3VsdHMpID0+IHtcbiAgICAgICAgICBpZiAoIXJlc3VsdHMpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELCBcIkFmdGVyRmluZCBleHBlY3QgcmVzdWx0cyB0byBiZSByZXR1cm5lZCBpbiB0aGUgcHJvbWlzZVwiKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH0pLnRoZW4oc3VjY2VzcywgZXJyb3IpO1xuICB9KS50aGVuKChyZXN1bHRzKSA9PiB7XG4gICAgbG9nVHJpZ2dlckFmdGVySG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBKU09OLnN0cmluZ2lmeShyZXN1bHRzKSwgYXV0aCk7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5RdWVyeVRyaWdnZXIodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgcmVzdFdoZXJlLCByZXN0T3B0aW9ucywgY29uZmlnLCBhdXRoLCBpc0dldCkge1xuICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdHJpZ2dlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe1xuICAgICAgcmVzdFdoZXJlLFxuICAgICAgcmVzdE9wdGlvbnNcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IHBhcnNlUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lKTtcbiAgaWYgKHJlc3RXaGVyZSkge1xuICAgIHBhcnNlUXVlcnkuX3doZXJlID0gcmVzdFdoZXJlO1xuICB9XG4gIGxldCBjb3VudCA9IGZhbHNlO1xuICBpZiAocmVzdE9wdGlvbnMpIHtcbiAgICBpZiAocmVzdE9wdGlvbnMuaW5jbHVkZSAmJiByZXN0T3B0aW9ucy5pbmNsdWRlLmxlbmd0aCA+IDApIHtcbiAgICAgIHBhcnNlUXVlcnkuX2luY2x1ZGUgPSByZXN0T3B0aW9ucy5pbmNsdWRlLnNwbGl0KCcsJyk7XG4gICAgfVxuICAgIGlmIChyZXN0T3B0aW9ucy5za2lwKSB7XG4gICAgICBwYXJzZVF1ZXJ5Ll9za2lwID0gcmVzdE9wdGlvbnMuc2tpcDtcbiAgICB9XG4gICAgaWYgKHJlc3RPcHRpb25zLmxpbWl0KSB7XG4gICAgICBwYXJzZVF1ZXJ5Ll9saW1pdCA9IHJlc3RPcHRpb25zLmxpbWl0O1xuICAgIH1cbiAgICBjb3VudCA9ICEhcmVzdE9wdGlvbnMuY291bnQ7XG4gIH1cbiAgY29uc3QgcmVxdWVzdE9iamVjdCA9IGdldFJlcXVlc3RRdWVyeU9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgcGFyc2VRdWVyeSwgY291bnQsIGNvbmZpZywgaXNHZXQpO1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRyaWdnZXIocmVxdWVzdE9iamVjdCk7XG4gIH0pLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgIGxldCBxdWVyeVJlc3VsdCA9IHBhcnNlUXVlcnk7XG4gICAgaWYgKHJlc3VsdCAmJiByZXN1bHQgaW5zdGFuY2VvZiBQYXJzZS5RdWVyeSkge1xuICAgICAgcXVlcnlSZXN1bHQgPSByZXN1bHQ7XG4gICAgfVxuICAgIGNvbnN0IGpzb25RdWVyeSA9IHF1ZXJ5UmVzdWx0LnRvSlNPTigpO1xuICAgIGlmIChqc29uUXVlcnkud2hlcmUpIHtcbiAgICAgIHJlc3RXaGVyZSA9IGpzb25RdWVyeS53aGVyZTtcbiAgICB9XG4gICAgaWYgKGpzb25RdWVyeS5saW1pdCkge1xuICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgIHJlc3RPcHRpb25zLmxpbWl0ID0ganNvblF1ZXJ5LmxpbWl0O1xuICAgIH1cbiAgICBpZiAoanNvblF1ZXJ5LnNraXApIHtcbiAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICByZXN0T3B0aW9ucy5za2lwID0ganNvblF1ZXJ5LnNraXA7XG4gICAgfVxuICAgIGlmIChqc29uUXVlcnkuaW5jbHVkZSkge1xuICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgPSBqc29uUXVlcnkuaW5jbHVkZTtcbiAgICB9XG4gICAgaWYgKGpzb25RdWVyeS5rZXlzKSB7XG4gICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgcmVzdE9wdGlvbnMua2V5cyA9IGpzb25RdWVyeS5rZXlzO1xuICAgIH1cbiAgICBpZiAoanNvblF1ZXJ5Lm9yZGVyKSB7XG4gICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgcmVzdE9wdGlvbnMub3JkZXIgPSBqc29uUXVlcnkub3JkZXI7XG4gICAgfVxuICAgIGlmIChyZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgcmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlO1xuICAgIH1cbiAgICBpZiAocmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICB9XG4gICAgaWYgKHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgIHJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICByZXN0V2hlcmUsXG4gICAgICByZXN0T3B0aW9uc1xuICAgIH07XG4gIH0sIChlcnIpID0+IHtcbiAgICBpZiAodHlwZW9mIGVyciA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxLCBlcnIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9KTtcbn1cblxuLy8gVG8gYmUgdXNlZCBhcyBwYXJ0IG9mIHRoZSBwcm9taXNlIGNoYWluIHdoZW4gc2F2aW5nL2RlbGV0aW5nIGFuIG9iamVjdFxuLy8gV2lsbCByZXNvbHZlIHN1Y2Nlc3NmdWxseSBpZiBubyB0cmlnZ2VyIGlzIGNvbmZpZ3VyZWRcbi8vIFJlc29sdmVzIHRvIGFuIG9iamVjdCwgZW1wdHkgb3IgY29udGFpbmluZyBhbiBvYmplY3Qga2V5LiBBIGJlZm9yZVNhdmVcbi8vIHRyaWdnZXIgd2lsbCBzZXQgdGhlIG9iamVjdCBrZXkgdG8gdGhlIHJlc3QgZm9ybWF0IG9iamVjdCB0byBzYXZlLlxuLy8gb3JpZ2luYWxQYXJzZU9iamVjdCBpcyBvcHRpb25hbCwgd2Ugb25seSBuZWVkIHRoYXQgZm9yIGJlZm9yZS9hZnRlclNhdmUgZnVuY3Rpb25zXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5UcmlnZ2VyKHRyaWdnZXJUeXBlLCBhdXRoLCBwYXJzZU9iamVjdCwgb3JpZ2luYWxQYXJzZU9iamVjdCwgY29uZmlnLCBjb250ZXh0KSB7XG4gIGlmICghcGFyc2VPYmplY3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihwYXJzZU9iamVjdC5jbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gICAgaWYgKCF0cmlnZ2VyKSByZXR1cm4gcmVzb2x2ZSgpO1xuICAgIHZhciByZXF1ZXN0ID0gZ2V0UmVxdWVzdE9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgcGFyc2VPYmplY3QsIG9yaWdpbmFsUGFyc2VPYmplY3QsIGNvbmZpZywgY29udGV4dCk7XG4gICAgdmFyIHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KHJlcXVlc3QsIChvYmplY3QpID0+IHtcbiAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSwgcGFyc2VPYmplY3QudG9KU09OKCksIG9iamVjdCwgYXV0aCk7XG4gICAgICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHwgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICBPYmplY3QuYXNzaWduKGNvbnRleHQsIHJlcXVlc3QuY29udGV4dCk7XG4gICAgICB9XG4gICAgICByZXNvbHZlKG9iamVjdCk7XG4gICAgfSwgKGVycm9yKSA9PiB7XG4gICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSwgcGFyc2VPYmplY3QuY2xhc3NOYW1lLCBwYXJzZU9iamVjdC50b0pTT04oKSwgYXV0aCwgZXJyb3IpO1xuICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICB9KTtcblxuICAgIC8vIEFmdGVyU2F2ZSBhbmQgYWZ0ZXJEZWxldGUgdHJpZ2dlcnMgY2FuIHJldHVybiBhIHByb21pc2UsIHdoaWNoIGlmIHRoZXlcbiAgICAvLyBkbywgbmVlZHMgdG8gYmUgcmVzb2x2ZWQgYmVmb3JlIHRoaXMgcHJvbWlzZSBpcyByZXNvbHZlZCxcbiAgICAvLyBzbyB0cmlnZ2VyIGV4ZWN1dGlvbiBpcyBzeW5jZWQgd2l0aCBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgLy8gSWYgdHJpZ2dlcnMgZG8gbm90IHJldHVybiBhIHByb21pc2UsIHRoZXkgY2FuIHJ1biBhc3luYyBjb2RlIHBhcmFsbGVsXG4gICAgLy8gdG8gdGhlIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCkudGhlbigoKSA9PiB7XG4gICAgICBjb25zdCBwcm9taXNlID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgIGlmKHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHwgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlKSB7XG4gICAgICAgIGxvZ1RyaWdnZXJBZnRlckhvb2sodHJpZ2dlclR5cGUsIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSwgcGFyc2VPYmplY3QudG9KU09OKCksIGF1dGgpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgfSkudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pO1xufVxuXG4vLyBDb252ZXJ0cyBhIFJFU1QtZm9ybWF0IG9iamVjdCB0byBhIFBhcnNlLk9iamVjdFxuLy8gZGF0YSBpcyBlaXRoZXIgY2xhc3NOYW1lIG9yIGFuIG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIGluZmxhdGUoZGF0YSwgcmVzdE9iamVjdCkge1xuICB2YXIgY29weSA9IHR5cGVvZiBkYXRhID09ICdvYmplY3QnID8gZGF0YSA6IHtjbGFzc05hbWU6IGRhdGF9O1xuICBmb3IgKHZhciBrZXkgaW4gcmVzdE9iamVjdCkge1xuICAgIGNvcHlba2V5XSA9IHJlc3RPYmplY3Rba2V5XTtcbiAgfVxuICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKGNvcHkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyhkYXRhLCBhcHBsaWNhdGlvbklkID0gUGFyc2UuYXBwbGljYXRpb25JZCkge1xuICBpZiAoIV90cmlnZ2VyU3RvcmUgfHwgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5KSB7IHJldHVybjsgfVxuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5mb3JFYWNoKChoYW5kbGVyKSA9PiBoYW5kbGVyKGRhdGEpKTtcbn1cbiJdfQ==