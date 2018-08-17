"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.HooksController = undefined;

var _triggers = require("../triggers");

var triggers = _interopRequireWildcard(_triggers);

var _node = require("parse/node");

var Parse = _interopRequireWildcard(_node);

var _request = require("request");

var request = _interopRequireWildcard(_request);

var _logger = require("../logger");

var _http = require("http");

var _http2 = _interopRequireDefault(_http);

var _https = require("https");

var _https2 = _interopRequireDefault(_https);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

// -disable-next
/**  weak */

const DefaultHooksCollectionName = "_Hooks";
// -disable-next

const HTTPAgents = {
  http: new _http2.default.Agent({ keepAlive: true }),
  https: new _https2.default.Agent({ keepAlive: true })
};

class HooksController {

  constructor(applicationId, databaseController, webhookKey) {
    this._applicationId = applicationId;
    this._webhookKey = webhookKey;
    this.database = databaseController;
  }

  load() {
    return this._getHooks().then(hooks => {
      hooks = hooks || [];
      hooks.forEach(hook => {
        this.addHookToTriggers(hook);
      });
    });
  }

  getFunction(functionName) {
    return this._getHooks({ functionName: functionName }).then(results => results[0]);
  }

  getFunctions() {
    return this._getHooks({ functionName: { $exists: true } });
  }

  getTrigger(className, triggerName) {
    return this._getHooks({ className: className, triggerName: triggerName }).then(results => results[0]);
  }

  getTriggers() {
    return this._getHooks({ className: { $exists: true }, triggerName: { $exists: true } });
  }

  deleteFunction(functionName) {
    triggers.removeFunction(functionName, this._applicationId);
    return this._removeHooks({ functionName: functionName });
  }

  deleteTrigger(className, triggerName) {
    triggers.removeTrigger(triggerName, className, this._applicationId);
    return this._removeHooks({ className: className, triggerName: triggerName });
  }

  _getHooks(query = {}) {
    return this.database.find(DefaultHooksCollectionName, query).then(results => {
      return results.map(result => {
        delete result.objectId;
        return result;
      });
    });
  }

  _removeHooks(query) {
    return this.database.destroy(DefaultHooksCollectionName, query).then(() => {
      return Promise.resolve({});
    });
  }

  saveHook(hook) {
    var query;
    if (hook.functionName && hook.url) {
      query = { functionName: hook.functionName };
    } else if (hook.triggerName && hook.className && hook.url) {
      query = { className: hook.className, triggerName: hook.triggerName };
    } else {
      throw new Parse.Error(143, "invalid hook declaration");
    }
    return this.database.update(DefaultHooksCollectionName, query, hook, { upsert: true }).then(() => {
      return Promise.resolve(hook);
    });
  }

  addHookToTriggers(hook) {
    var wrappedFunction = wrapToHTTPRequest(hook, this._webhookKey);
    wrappedFunction.url = hook.url;
    if (hook.className) {
      triggers.addTrigger(hook.triggerName, hook.className, wrappedFunction, this._applicationId);
    } else {
      triggers.addFunction(hook.functionName, wrappedFunction, null, this._applicationId);
    }
  }

  addHook(hook) {
    this.addHookToTriggers(hook);
    return this.saveHook(hook);
  }

  createOrUpdateHook(aHook) {
    var hook;
    if (aHook && aHook.functionName && aHook.url) {
      hook = {};
      hook.functionName = aHook.functionName;
      hook.url = aHook.url;
    } else if (aHook && aHook.className && aHook.url && aHook.triggerName && triggers.Types[aHook.triggerName]) {
      hook = {};
      hook.className = aHook.className;
      hook.url = aHook.url;
      hook.triggerName = aHook.triggerName;
    } else {
      throw new Parse.Error(143, "invalid hook declaration");
    }

    return this.addHook(hook);
  }

  createHook(aHook) {
    if (aHook.functionName) {
      return this.getFunction(aHook.functionName).then(result => {
        if (result) {
          throw new Parse.Error(143, `function name: ${aHook.functionName} already exits`);
        } else {
          return this.createOrUpdateHook(aHook);
        }
      });
    } else if (aHook.className && aHook.triggerName) {
      return this.getTrigger(aHook.className, aHook.triggerName).then(result => {
        if (result) {
          throw new Parse.Error(143, `class ${aHook.className} already has trigger ${aHook.triggerName}`);
        }
        return this.createOrUpdateHook(aHook);
      });
    }

    throw new Parse.Error(143, "invalid hook declaration");
  }

  updateHook(aHook) {
    if (aHook.functionName) {
      return this.getFunction(aHook.functionName).then(result => {
        if (result) {
          return this.createOrUpdateHook(aHook);
        }
        throw new Parse.Error(143, `no function named: ${aHook.functionName} is defined`);
      });
    } else if (aHook.className && aHook.triggerName) {
      return this.getTrigger(aHook.className, aHook.triggerName).then(result => {
        if (result) {
          return this.createOrUpdateHook(aHook);
        }
        throw new Parse.Error(143, `class ${aHook.className} does not exist`);
      });
    }
    throw new Parse.Error(143, "invalid hook declaration");
  }
}

exports.HooksController = HooksController;
function wrapToHTTPRequest(hook, key) {
  return req => {
    const jsonBody = {};
    for (var i in req) {
      jsonBody[i] = req[i];
    }
    if (req.object) {
      jsonBody.object = req.object.toJSON();
      jsonBody.object.className = req.object.className;
    }
    if (req.original) {
      jsonBody.original = req.original.toJSON();
      jsonBody.original.className = req.original.className;
    }
    const jsonRequest = {
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(jsonBody)
    };

    const agent = hook.url.startsWith('https') ? HTTPAgents['https'] : HTTPAgents['http'];
    jsonRequest.agent = agent;

    if (key) {
      jsonRequest.headers['X-Parse-Webhook-Key'] = key;
    } else {
      _logger.logger.warn('Making outgoing webhook request without webhookKey being set!');
    }

    return new Promise((resolve, reject) => {
      request.post(hook.url, jsonRequest, function (err, httpResponse, body) {
        var result;
        if (body) {
          if (typeof body === "string") {
            try {
              body = JSON.parse(body);
            } catch (e) {
              err = {
                error: "Malformed response",
                code: -1,
                partialResponse: body.substring(0, 100)
              };
            }
          }
          if (!err) {
            result = body.success;
            err = body.error;
          }
        }
        if (err) {
          return reject(err);
        } else if (hook.triggerName === 'beforeSave') {
          if (typeof result === 'object') {
            delete result.createdAt;
            delete result.updatedAt;
          }
          return resolve({ object: result });
        } else {
          return resolve(result);
        }
      });
    });
  };
}

exports.default = HooksController;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Db250cm9sbGVycy9Ib29rc0NvbnRyb2xsZXIuanMiXSwibmFtZXMiOlsidHJpZ2dlcnMiLCJQYXJzZSIsInJlcXVlc3QiLCJEZWZhdWx0SG9va3NDb2xsZWN0aW9uTmFtZSIsIkhUVFBBZ2VudHMiLCJodHRwIiwiQWdlbnQiLCJrZWVwQWxpdmUiLCJodHRwcyIsIkhvb2tzQ29udHJvbGxlciIsImNvbnN0cnVjdG9yIiwiYXBwbGljYXRpb25JZCIsImRhdGFiYXNlQ29udHJvbGxlciIsIndlYmhvb2tLZXkiLCJfYXBwbGljYXRpb25JZCIsIl93ZWJob29rS2V5IiwiZGF0YWJhc2UiLCJsb2FkIiwiX2dldEhvb2tzIiwidGhlbiIsImhvb2tzIiwiZm9yRWFjaCIsImhvb2siLCJhZGRIb29rVG9UcmlnZ2VycyIsImdldEZ1bmN0aW9uIiwiZnVuY3Rpb25OYW1lIiwicmVzdWx0cyIsImdldEZ1bmN0aW9ucyIsIiRleGlzdHMiLCJnZXRUcmlnZ2VyIiwiY2xhc3NOYW1lIiwidHJpZ2dlck5hbWUiLCJnZXRUcmlnZ2VycyIsImRlbGV0ZUZ1bmN0aW9uIiwicmVtb3ZlRnVuY3Rpb24iLCJfcmVtb3ZlSG9va3MiLCJkZWxldGVUcmlnZ2VyIiwicmVtb3ZlVHJpZ2dlciIsInF1ZXJ5IiwiZmluZCIsIm1hcCIsInJlc3VsdCIsIm9iamVjdElkIiwiZGVzdHJveSIsIlByb21pc2UiLCJyZXNvbHZlIiwic2F2ZUhvb2siLCJ1cmwiLCJFcnJvciIsInVwZGF0ZSIsInVwc2VydCIsIndyYXBwZWRGdW5jdGlvbiIsIndyYXBUb0hUVFBSZXF1ZXN0IiwiYWRkVHJpZ2dlciIsImFkZEZ1bmN0aW9uIiwiYWRkSG9vayIsImNyZWF0ZU9yVXBkYXRlSG9vayIsImFIb29rIiwiVHlwZXMiLCJjcmVhdGVIb29rIiwidXBkYXRlSG9vayIsImtleSIsInJlcSIsImpzb25Cb2R5IiwiaSIsIm9iamVjdCIsInRvSlNPTiIsIm9yaWdpbmFsIiwianNvblJlcXVlc3QiLCJoZWFkZXJzIiwiYm9keSIsIkpTT04iLCJzdHJpbmdpZnkiLCJhZ2VudCIsInN0YXJ0c1dpdGgiLCJsb2dnZXIiLCJ3YXJuIiwicmVqZWN0IiwicG9zdCIsImVyciIsImh0dHBSZXNwb25zZSIsInBhcnNlIiwiZSIsImVycm9yIiwiY29kZSIsInBhcnRpYWxSZXNwb25zZSIsInN1YnN0cmluZyIsInN1Y2Nlc3MiLCJjcmVhdGVkQXQiLCJ1cGRhdGVkQXQiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFFQTs7SUFBWUEsUTs7QUFFWjs7SUFBWUMsSzs7QUFFWjs7SUFBWUMsTzs7QUFDWjs7QUFDQTs7OztBQUNBOzs7Ozs7OztBQUpBO0FBTEE7O0FBV0EsTUFBTUMsNkJBQTZCLFFBQW5DO0FBUkE7O0FBU0EsTUFBTUMsYUFBYTtBQUNqQkMsUUFBTSxJQUFJQSxlQUFLQyxLQUFULENBQWUsRUFBRUMsV0FBVyxJQUFiLEVBQWYsQ0FEVztBQUVqQkMsU0FBTyxJQUFJQSxnQkFBTUYsS0FBVixDQUFnQixFQUFFQyxXQUFXLElBQWIsRUFBaEI7QUFGVSxDQUFuQjs7QUFLTyxNQUFNRSxlQUFOLENBQXNCOztBQUszQkMsY0FBWUMsYUFBWixFQUFrQ0Msa0JBQWxDLEVBQXNEQyxVQUF0RCxFQUFrRTtBQUNoRSxTQUFLQyxjQUFMLEdBQXNCSCxhQUF0QjtBQUNBLFNBQUtJLFdBQUwsR0FBbUJGLFVBQW5CO0FBQ0EsU0FBS0csUUFBTCxHQUFnQkosa0JBQWhCO0FBQ0Q7O0FBRURLLFNBQU87QUFDTCxXQUFPLEtBQUtDLFNBQUwsR0FBaUJDLElBQWpCLENBQXNCQyxTQUFTO0FBQ3BDQSxjQUFRQSxTQUFTLEVBQWpCO0FBQ0FBLFlBQU1DLE9BQU4sQ0FBZUMsSUFBRCxJQUFVO0FBQ3RCLGFBQUtDLGlCQUFMLENBQXVCRCxJQUF2QjtBQUNELE9BRkQ7QUFHRCxLQUxNLENBQVA7QUFNRDs7QUFFREUsY0FBWUMsWUFBWixFQUEwQjtBQUN4QixXQUFPLEtBQUtQLFNBQUwsQ0FBZSxFQUFFTyxjQUFjQSxZQUFoQixFQUFmLEVBQStD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O0FBQ0Y7QUFDRCxjQUFJLENBQUNQLEdBQUwsRUFBVTtBQUNSdEMscUJBQVM2QixLQUFLaUIsT0FBZDtBQUNBUixrQkFBTVQsS0FBS2EsS0FBWDtBQUNEO0FBQ0Y7QUFDRCxZQUFJSixHQUFKLEVBQVM7QUFDUCxpQkFBT0YsT0FBT0UsR0FBUCxDQUFQO0FBQ0QsU0FGRCxNQUVPLElBQUl6RCxLQUFLUyxXQUFMLEtBQXFCLFlBQXpCLEVBQXVDO0FBQzVDLGNBQUksT0FBT1UsTUFBUCxLQUFrQixRQUF0QixFQUFnQztBQUM5QixtQkFBT0EsT0FBTytDLFNBQWQ7QUFDQSxtQkFBTy9DLE9BQU9nRCxTQUFkO0FBQ0Q7QUFDRCxpQkFBTzVDLFFBQVEsRUFBQ29CLFFBQVF4QixNQUFULEVBQVIsQ0FBUDtBQUNELFNBTk0sTUFNQTtBQUNMLGlCQUFPSSxRQUFRSixNQUFSLENBQVA7QUFDRDtBQUNGLE9BOUJEO0FBK0JELEtBaENNLENBQVA7QUFpQ0QsR0E5REQ7QUErREQ7O2tCQUVjaEMsZSIsImZpbGUiOiJIb29rc0NvbnRyb2xsZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQGZsb3cgd2VhayAqL1xuXG5pbXBvcnQgKiBhcyB0cmlnZ2VycyAgICAgICAgZnJvbSBcIi4uL3RyaWdnZXJzXCI7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCAqIGFzIFBhcnNlICAgICAgICAgICBmcm9tIFwicGFyc2Uvbm9kZVwiO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgKiBhcyByZXF1ZXN0ICAgICAgICAgZnJvbSBcInJlcXVlc3RcIjtcbmltcG9ydCB7IGxvZ2dlciB9ICAgICAgICAgICBmcm9tICcuLi9sb2dnZXInO1xuaW1wb3J0IGh0dHAgICAgICAgICAgICAgICAgIGZyb20gJ2h0dHAnO1xuaW1wb3J0IGh0dHBzICAgICAgICAgICAgICAgIGZyb20gJ2h0dHBzJztcblxuY29uc3QgRGVmYXVsdEhvb2tzQ29sbGVjdGlvbk5hbWUgPSBcIl9Ib29rc1wiO1xuY29uc3QgSFRUUEFnZW50cyA9IHtcbiAgaHR0cDogbmV3IGh0dHAuQWdlbnQoeyBrZWVwQWxpdmU6IHRydWUgfSksXG4gIGh0dHBzOiBuZXcgaHR0cHMuQWdlbnQoeyBrZWVwQWxpdmU6IHRydWUgfSksXG59XG5cbmV4cG9ydCBjbGFzcyBIb29rc0NvbnRyb2xsZXIge1xuICBfYXBwbGljYXRpb25JZDpzdHJpbmc7XG4gIF93ZWJob29rS2V5OnN0cmluZztcbiAgZGF0YWJhc2U6IGFueTtcblxuICBjb25zdHJ1Y3RvcihhcHBsaWNhdGlvbklkOnN0cmluZywgZGF0YWJhc2VDb250cm9sbGVyLCB3ZWJob29rS2V5KSB7XG4gICAgdGhpcy5fYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQ7XG4gICAgdGhpcy5fd2ViaG9va0tleSA9IHdlYmhvb2tLZXk7XG4gICAgdGhpcy5kYXRhYmFzZSA9IGRhdGFiYXNlQ29udHJvbGxlcjtcbiAgfVxuXG4gIGxvYWQoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2dldEhvb2tzKCkudGhlbihob29rcyA9PiB7XG4gICAgICBob29rcyA9IGhvb2tzIHx8IFtdO1xuICAgICAgaG9va3MuZm9yRWFjaCgoaG9vaykgPT4ge1xuICAgICAgICB0aGlzLmFkZEhvb2tUb1RyaWdnZXJzKGhvb2spO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBnZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy5fZ2V0SG9va3MoeyBmdW5jdGlvbk5hbWU6IGZ1bmN0aW9uTmFtZSB9KS50aGVuKHJlc3VsdHMgPT4gcmVzdWx0c1swXSk7XG4gIH1cblxuICBnZXRGdW5jdGlvbnMoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2dldEhvb2tzKHsgZnVuY3Rpb25OYW1lOiB7ICRleGlzdHM6IHRydWUgfSB9KTtcbiAgfVxuXG4gIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyTmFtZSkge1xuICAgIHJldHVybiB0aGlzLl9nZXRIb29rcyh7IGNsYXNzTmFtZTogY2xhc3NOYW1lLCB0cmlnZ2VyTmFtZTogdHJpZ2dlck5hbWUgfSkudGhlbihyZXN1bHRzID0+IHJlc3VsdHNbMF0pO1xuICB9XG5cbiAgZ2V0VHJpZ2dlcnMoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2dldEhvb2tzKHsgY2xhc3NOYW1lOiB7ICRleGlzdHM6IHRydWUgfSwgdHJpZ2dlck5hbWU6IHsgJGV4aXN0czogdHJ1ZSB9IH0pO1xuICB9XG5cbiAgZGVsZXRlRnVuY3Rpb24oZnVuY3Rpb25OYW1lKSB7XG4gICAgdHJpZ2dlcnMucmVtb3ZlRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCB0aGlzLl9hcHBsaWNhdGlvbklkKTtcbiAgICByZXR1cm4gdGhpcy5fcmVtb3ZlSG9va3MoeyBmdW5jdGlvbk5hbWU6IGZ1bmN0aW9uTmFtZSB9KTtcbiAgfVxuXG4gIGRlbGV0ZVRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyTmFtZSkge1xuICAgIHRyaWdnZXJzLnJlbW92ZVRyaWdnZXIodHJpZ2dlck5hbWUsIGNsYXNzTmFtZSwgdGhpcy5fYXBwbGljYXRpb25JZCk7XG4gICAgcmV0dXJuIHRoaXMuX3JlbW92ZUhvb2tzKHsgY2xhc3NOYW1lOiBjbGFzc05hbWUsIHRyaWdnZXJOYW1lOiB0cmlnZ2VyTmFtZSB9KTtcbiAgfVxuXG4gIF9nZXRIb29rcyhxdWVyeSA9IHt9KSB7XG4gICAgcmV0dXJuIHRoaXMuZGF0YWJhc2UuZmluZChEZWZhdWx0SG9va3NDb2xsZWN0aW9uTmFtZSwgcXVlcnkpLnRoZW4oKHJlc3VsdHMpID0+IHtcbiAgICAgIHJldHVybiByZXN1bHRzLm1hcCgocmVzdWx0KSA9PiB7XG4gICAgICAgIGRlbGV0ZSByZXN1bHQub2JqZWN0SWQ7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIF9yZW1vdmVIb29rcyhxdWVyeSkge1xuICAgIHJldHVybiB0aGlzLmRhdGFiYXNlLmRlc3Ryb3koRGVmYXVsdEhvb2tzQ29sbGVjdGlvbk5hbWUsIHF1ZXJ5KS50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICAgIH0pO1xuICB9XG5cbiAgc2F2ZUhvb2soaG9vaykge1xuICAgIHZhciBxdWVyeTtcbiAgICBpZiAoaG9vay5mdW5jdGlvbk5hbWUgJiYgaG9vay51cmwpIHtcbiAgICAgIHF1ZXJ5ID0geyBmdW5jdGlvbk5hbWU6IGhvb2suZnVuY3Rpb25OYW1lIH1cbiAgICB9IGVsc2UgaWYgKGhvb2sudHJpZ2dlck5hbWUgJiYgaG9vay5jbGFzc05hbWUgJiYgaG9vay51cmwpIHtcbiAgICAgIHF1ZXJ5ID0geyBjbGFzc05hbWU6IGhvb2suY2xhc3NOYW1lLCB0cmlnZ2VyTmFtZTogaG9vay50cmlnZ2VyTmFtZSB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxNDMsIFwiaW52YWxpZCBob29rIGRlY2xhcmF0aW9uXCIpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5kYXRhYmFzZS51cGRhdGUoRGVmYXVsdEhvb2tzQ29sbGVjdGlvbk5hbWUsIHF1ZXJ5LCBob29rLCB7dXBzZXJ0OiB0cnVlfSkudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGhvb2spO1xuICAgIH0pXG4gIH1cblxuICBhZGRIb29rVG9UcmlnZ2Vycyhob29rKSB7XG4gICAgdmFyIHdyYXBwZWRGdW5jdGlvbiA9IHdyYXBUb0hUVFBSZXF1ZXN0KGhvb2ssIHRoaXMuX3dlYmhvb2tLZXkpO1xuICAgIHdyYXBwZWRGdW5jdGlvbi51cmwgPSBob29rLnVybDtcbiAgICBpZiAoaG9vay5jbGFzc05hbWUpIHtcbiAgICAgIHRyaWdnZXJzLmFkZFRyaWdnZXIoaG9vay50cmlnZ2VyTmFtZSwgaG9vay5jbGFzc05hbWUsIHdyYXBwZWRGdW5jdGlvbiwgdGhpcy5fYXBwbGljYXRpb25JZClcbiAgICB9IGVsc2Uge1xuICAgICAgdHJpZ2dlcnMuYWRkRnVuY3Rpb24oaG9vay5mdW5jdGlvbk5hbWUsIHdyYXBwZWRGdW5jdGlvbiwgbnVsbCwgdGhpcy5fYXBwbGljYXRpb25JZCk7XG4gICAgfVxuICB9XG5cbiAgYWRkSG9vayhob29rKSB7XG4gICAgdGhpcy5hZGRIb29rVG9UcmlnZ2Vycyhob29rKTtcbiAgICByZXR1cm4gdGhpcy5zYXZlSG9vayhob29rKTtcbiAgfVxuXG4gIGNyZWF0ZU9yVXBkYXRlSG9vayhhSG9vaykge1xuICAgIHZhciBob29rO1xuICAgIGlmIChhSG9vayAmJiBhSG9vay5mdW5jdGlvbk5hbWUgJiYgYUhvb2sudXJsKSB7XG4gICAgICBob29rID0ge307XG4gICAgICBob29rLmZ1bmN0aW9uTmFtZSA9IGFIb29rLmZ1bmN0aW9uTmFtZTtcbiAgICAgIGhvb2sudXJsID0gYUhvb2sudXJsO1xuICAgIH0gZWxzZSBpZiAoYUhvb2sgJiYgYUhvb2suY2xhc3NOYW1lICYmIGFIb29rLnVybCAmJiBhSG9vay50cmlnZ2VyTmFtZSAmJiB0cmlnZ2Vycy5UeXBlc1thSG9vay50cmlnZ2VyTmFtZV0pIHtcbiAgICAgIGhvb2sgPSB7fTtcbiAgICAgIGhvb2suY2xhc3NOYW1lID0gYUhvb2suY2xhc3NOYW1lO1xuICAgICAgaG9vay51cmwgPSBhSG9vay51cmw7XG4gICAgICBob29rLnRyaWdnZXJOYW1lID0gYUhvb2sudHJpZ2dlck5hbWU7XG5cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDE0MywgXCJpbnZhbGlkIGhvb2sgZGVjbGFyYXRpb25cIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuYWRkSG9vayhob29rKTtcbiAgfVxuXG4gIGNyZWF0ZUhvb2soYUhvb2spIHtcbiAgICBpZiAoYUhvb2suZnVuY3Rpb25OYW1lKSB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRGdW5jdGlvbihhSG9vay5mdW5jdGlvbk5hbWUpLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDE0MywgYGZ1bmN0aW9uIG5hbWU6ICR7YUhvb2suZnVuY3Rpb25OYW1lfSBhbHJlYWR5IGV4aXRzYCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlT3JVcGRhdGVIb29rKGFIb29rKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChhSG9vay5jbGFzc05hbWUgJiYgYUhvb2sudHJpZ2dlck5hbWUpIHtcbiAgICAgIHJldHVybiB0aGlzLmdldFRyaWdnZXIoYUhvb2suY2xhc3NOYW1lLCBhSG9vay50cmlnZ2VyTmFtZSkudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTQzLCBgY2xhc3MgJHthSG9vay5jbGFzc05hbWV9IGFscmVhZHkgaGFzIHRyaWdnZXIgJHthSG9vay50cmlnZ2VyTmFtZX1gKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVPclVwZGF0ZUhvb2soYUhvb2spO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDE0MywgXCJpbnZhbGlkIGhvb2sgZGVjbGFyYXRpb25cIik7XG4gIH1cblxuICB1cGRhdGVIb29rKGFIb29rKSB7XG4gICAgaWYgKGFIb29rLmZ1bmN0aW9uTmFtZSkge1xuICAgICAgcmV0dXJuIHRoaXMuZ2V0RnVuY3Rpb24oYUhvb2suZnVuY3Rpb25OYW1lKS50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgIHJldHVybiB0aGlzLmNyZWF0ZU9yVXBkYXRlSG9vayhhSG9vayk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDE0MywgYG5vIGZ1bmN0aW9uIG5hbWVkOiAke2FIb29rLmZ1bmN0aW9uTmFtZX0gaXMgZGVmaW5lZGApO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChhSG9vay5jbGFzc05hbWUgJiYgYUhvb2sudHJpZ2dlck5hbWUpIHtcbiAgICAgIHJldHVybiB0aGlzLmdldFRyaWdnZXIoYUhvb2suY2xhc3NOYW1lLCBhSG9vay50cmlnZ2VyTmFtZSkudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVPclVwZGF0ZUhvb2soYUhvb2spO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxNDMsIGBjbGFzcyAke2FIb29rLmNsYXNzTmFtZX0gZG9lcyBub3QgZXhpc3RgKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTQzLCBcImludmFsaWQgaG9vayBkZWNsYXJhdGlvblwiKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB3cmFwVG9IVFRQUmVxdWVzdChob29rLCBrZXkpIHtcbiAgcmV0dXJuIChyZXEpID0+IHtcbiAgICBjb25zdCBqc29uQm9keSA9IHt9O1xuICAgIGZvciAodmFyIGkgaW4gcmVxKSB7XG4gICAgICBqc29uQm9keVtpXSA9IHJlcVtpXTtcbiAgICB9XG4gICAgaWYgKHJlcS5vYmplY3QpIHtcbiAgICAgIGpzb25Cb2R5Lm9iamVjdCA9IHJlcS5vYmplY3QudG9KU09OKCk7XG4gICAgICBqc29uQm9keS5vYmplY3QuY2xhc3NOYW1lID0gcmVxLm9iamVjdC5jbGFzc05hbWU7XG4gICAgfVxuICAgIGlmIChyZXEub3JpZ2luYWwpIHtcbiAgICAgIGpzb25Cb2R5Lm9yaWdpbmFsID0gcmVxLm9yaWdpbmFsLnRvSlNPTigpO1xuICAgICAganNvbkJvZHkub3JpZ2luYWwuY2xhc3NOYW1lID0gcmVxLm9yaWdpbmFsLmNsYXNzTmFtZTtcbiAgICB9XG4gICAgY29uc3QganNvblJlcXVlc3Q6IGFueSA9IHtcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGpzb25Cb2R5KSxcbiAgICB9O1xuXG4gICAgY29uc3QgYWdlbnQgPSBob29rLnVybC5zdGFydHNXaXRoKCdodHRwcycpID8gSFRUUEFnZW50c1snaHR0cHMnXSA6IEhUVFBBZ2VudHNbJ2h0dHAnXTtcbiAgICBqc29uUmVxdWVzdC5hZ2VudCA9IGFnZW50O1xuXG4gICAgaWYgKGtleSkge1xuICAgICAganNvblJlcXVlc3QuaGVhZGVyc1snWC1QYXJzZS1XZWJob29rLUtleSddID0ga2V5O1xuICAgIH0gZWxzZSB7XG4gICAgICBsb2dnZXIud2FybignTWFraW5nIG91dGdvaW5nIHdlYmhvb2sgcmVxdWVzdCB3aXRob3V0IHdlYmhvb2tLZXkgYmVpbmcgc2V0IScpO1xuICAgIH1cblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICByZXF1ZXN0LnBvc3QoaG9vay51cmwsIGpzb25SZXF1ZXN0LCBmdW5jdGlvbiAoZXJyLCBodHRwUmVzcG9uc2UsIGJvZHkpIHtcbiAgICAgICAgdmFyIHJlc3VsdDtcbiAgICAgICAgaWYgKGJvZHkpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGJvZHkgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKGJvZHkpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBlcnIgPSB7XG4gICAgICAgICAgICAgICAgZXJyb3I6IFwiTWFsZm9ybWVkIHJlc3BvbnNlXCIsXG4gICAgICAgICAgICAgICAgY29kZTogLTEsXG4gICAgICAgICAgICAgICAgcGFydGlhbFJlc3BvbnNlOiBib2R5LnN1YnN0cmluZygwLCAxMDApXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICghZXJyKSB7XG4gICAgICAgICAgICByZXN1bHQgPSBib2R5LnN1Y2Nlc3M7XG4gICAgICAgICAgICBlcnIgPSBib2R5LmVycm9yO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgcmV0dXJuIHJlamVjdChlcnIpO1xuICAgICAgICB9IGVsc2UgaWYgKGhvb2sudHJpZ2dlck5hbWUgPT09ICdiZWZvcmVTYXZlJykge1xuICAgICAgICAgIGlmICh0eXBlb2YgcmVzdWx0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5jcmVhdGVkQXQ7XG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnVwZGF0ZWRBdDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlc29sdmUoe29iamVjdDogcmVzdWx0fSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgSG9va3NDb250cm9sbGVyO1xuIl19