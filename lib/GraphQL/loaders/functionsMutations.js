"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.load = void 0;

var _graphql = require("graphql");

var _FunctionsRouter = require("../../Routers/FunctionsRouter");

var defaultGraphQLTypes = _interopRequireWildcard(require("./defaultGraphQLTypes"));

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { keys.push.apply(keys, Object.getOwnPropertySymbols(object)); } if (enumerableOnly) keys = keys.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(source, true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const load = parseGraphQLSchema => {
  if (parseGraphQLSchema.functionNames.length > 0) {
    const cloudCodeFunctionEnum = parseGraphQLSchema.addGraphQLType(new _graphql.GraphQLEnumType({
      name: 'CloudCodeFunction',
      description: 'The CloudCodeFunction enum type contains a list of all available cloud code functions.',
      values: parseGraphQLSchema.functionNames.reduce((values, functionName) => _objectSpread({}, values, {
        [functionName]: {
          value: functionName
        }
      }), {})
    }), true, true);
    parseGraphQLSchema.addGraphQLMutation('callCloudCode', {
      description: 'The call mutation can be used to invoke a cloud code function.',
      args: {
        functionName: {
          description: 'This is the function to be called.',
          type: new _graphql.GraphQLNonNull(cloudCodeFunctionEnum)
        },
        params: {
          description: 'These are the params to be passed to the function.',
          type: defaultGraphQLTypes.OBJECT
        }
      },
      type: defaultGraphQLTypes.ANY,

      async resolve(_source, args, context) {
        try {
          const {
            functionName,
            params
          } = args;
          const {
            config,
            auth,
            info
          } = context;
          return (await _FunctionsRouter.FunctionsRouter.handleCloudFunction({
            params: {
              functionName
            },
            config,
            auth,
            info,
            body: params
          })).response.result;
        } catch (e) {
          parseGraphQLSchema.handleError(e);
        }
      }

    }, true, true);
  }
};

exports.load = load;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2xvYWRlcnMvZnVuY3Rpb25zTXV0YXRpb25zLmpzIl0sIm5hbWVzIjpbImxvYWQiLCJwYXJzZUdyYXBoUUxTY2hlbWEiLCJmdW5jdGlvbk5hbWVzIiwibGVuZ3RoIiwiY2xvdWRDb2RlRnVuY3Rpb25FbnVtIiwiYWRkR3JhcGhRTFR5cGUiLCJHcmFwaFFMRW51bVR5cGUiLCJuYW1lIiwiZGVzY3JpcHRpb24iLCJ2YWx1ZXMiLCJyZWR1Y2UiLCJmdW5jdGlvbk5hbWUiLCJ2YWx1ZSIsImFkZEdyYXBoUUxNdXRhdGlvbiIsImFyZ3MiLCJ0eXBlIiwiR3JhcGhRTE5vbk51bGwiLCJwYXJhbXMiLCJkZWZhdWx0R3JhcGhRTFR5cGVzIiwiT0JKRUNUIiwiQU5ZIiwicmVzb2x2ZSIsIl9zb3VyY2UiLCJjb250ZXh0IiwiY29uZmlnIiwiYXV0aCIsImluZm8iLCJGdW5jdGlvbnNSb3V0ZXIiLCJoYW5kbGVDbG91ZEZ1bmN0aW9uIiwiYm9keSIsInJlc3BvbnNlIiwicmVzdWx0IiwiZSIsImhhbmRsZUVycm9yIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBQ0E7O0FBQ0E7Ozs7Ozs7Ozs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLGtCQUFrQixJQUFJO0FBQ2pDLE1BQUlBLGtCQUFrQixDQUFDQyxhQUFuQixDQUFpQ0MsTUFBakMsR0FBMEMsQ0FBOUMsRUFBaUQ7QUFDL0MsVUFBTUMscUJBQXFCLEdBQUdILGtCQUFrQixDQUFDSSxjQUFuQixDQUM1QixJQUFJQyx3QkFBSixDQUFvQjtBQUNsQkMsTUFBQUEsSUFBSSxFQUFFLG1CQURZO0FBRWxCQyxNQUFBQSxXQUFXLEVBQ1Qsd0ZBSGdCO0FBSWxCQyxNQUFBQSxNQUFNLEVBQUVSLGtCQUFrQixDQUFDQyxhQUFuQixDQUFpQ1EsTUFBakMsQ0FDTixDQUFDRCxNQUFELEVBQVNFLFlBQVQsdUJBQ0tGLE1BREw7QUFFRSxTQUFDRSxZQUFELEdBQWdCO0FBQUVDLFVBQUFBLEtBQUssRUFBRUQ7QUFBVDtBQUZsQixRQURNLEVBS04sRUFMTTtBQUpVLEtBQXBCLENBRDRCLEVBYTVCLElBYjRCLEVBYzVCLElBZDRCLENBQTlCO0FBaUJBVixJQUFBQSxrQkFBa0IsQ0FBQ1ksa0JBQW5CLENBQ0UsZUFERixFQUVFO0FBQ0VMLE1BQUFBLFdBQVcsRUFDVCxnRUFGSjtBQUdFTSxNQUFBQSxJQUFJLEVBQUU7QUFDSkgsUUFBQUEsWUFBWSxFQUFFO0FBQ1pILFVBQUFBLFdBQVcsRUFBRSxvQ0FERDtBQUVaTyxVQUFBQSxJQUFJLEVBQUUsSUFBSUMsdUJBQUosQ0FBbUJaLHFCQUFuQjtBQUZNLFNBRFY7QUFLSmEsUUFBQUEsTUFBTSxFQUFFO0FBQ05ULFVBQUFBLFdBQVcsRUFBRSxvREFEUDtBQUVOTyxVQUFBQSxJQUFJLEVBQUVHLG1CQUFtQixDQUFDQztBQUZwQjtBQUxKLE9BSFI7QUFhRUosTUFBQUEsSUFBSSxFQUFFRyxtQkFBbUIsQ0FBQ0UsR0FiNUI7O0FBY0UsWUFBTUMsT0FBTixDQUFjQyxPQUFkLEVBQXVCUixJQUF2QixFQUE2QlMsT0FBN0IsRUFBc0M7QUFDcEMsWUFBSTtBQUNGLGdCQUFNO0FBQUVaLFlBQUFBLFlBQUY7QUFBZ0JNLFlBQUFBO0FBQWhCLGNBQTJCSCxJQUFqQztBQUNBLGdCQUFNO0FBQUVVLFlBQUFBLE1BQUY7QUFBVUMsWUFBQUEsSUFBVjtBQUFnQkMsWUFBQUE7QUFBaEIsY0FBeUJILE9BQS9CO0FBRUEsaUJBQU8sQ0FBQyxNQUFNSSxpQ0FBZ0JDLG1CQUFoQixDQUFvQztBQUNoRFgsWUFBQUEsTUFBTSxFQUFFO0FBQ05OLGNBQUFBO0FBRE0sYUFEd0M7QUFJaERhLFlBQUFBLE1BSmdEO0FBS2hEQyxZQUFBQSxJQUxnRDtBQU1oREMsWUFBQUEsSUFOZ0Q7QUFPaERHLFlBQUFBLElBQUksRUFBRVo7QUFQMEMsV0FBcEMsQ0FBUCxFQVFIYSxRQVJHLENBUU1DLE1BUmI7QUFTRCxTQWJELENBYUUsT0FBT0MsQ0FBUCxFQUFVO0FBQ1YvQixVQUFBQSxrQkFBa0IsQ0FBQ2dDLFdBQW5CLENBQStCRCxDQUEvQjtBQUNEO0FBQ0Y7O0FBL0JILEtBRkYsRUFtQ0UsSUFuQ0YsRUFvQ0UsSUFwQ0Y7QUFzQ0Q7QUFDRixDQTFERCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEdyYXBoUUxOb25OdWxsLCBHcmFwaFFMRW51bVR5cGUgfSBmcm9tICdncmFwaHFsJztcbmltcG9ydCB7IEZ1bmN0aW9uc1JvdXRlciB9IGZyb20gJy4uLy4uL1JvdXRlcnMvRnVuY3Rpb25zUm91dGVyJztcbmltcG9ydCAqIGFzIGRlZmF1bHRHcmFwaFFMVHlwZXMgZnJvbSAnLi9kZWZhdWx0R3JhcGhRTFR5cGVzJztcblxuY29uc3QgbG9hZCA9IHBhcnNlR3JhcGhRTFNjaGVtYSA9PiB7XG4gIGlmIChwYXJzZUdyYXBoUUxTY2hlbWEuZnVuY3Rpb25OYW1lcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY2xvdWRDb2RlRnVuY3Rpb25FbnVtID0gcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgICAgbmV3IEdyYXBoUUxFbnVtVHlwZSh7XG4gICAgICAgIG5hbWU6ICdDbG91ZENvZGVGdW5jdGlvbicsXG4gICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgICdUaGUgQ2xvdWRDb2RlRnVuY3Rpb24gZW51bSB0eXBlIGNvbnRhaW5zIGEgbGlzdCBvZiBhbGwgYXZhaWxhYmxlIGNsb3VkIGNvZGUgZnVuY3Rpb25zLicsXG4gICAgICAgIHZhbHVlczogcGFyc2VHcmFwaFFMU2NoZW1hLmZ1bmN0aW9uTmFtZXMucmVkdWNlKFxuICAgICAgICAgICh2YWx1ZXMsIGZ1bmN0aW9uTmFtZSkgPT4gKHtcbiAgICAgICAgICAgIC4uLnZhbHVlcyxcbiAgICAgICAgICAgIFtmdW5jdGlvbk5hbWVdOiB7IHZhbHVlOiBmdW5jdGlvbk5hbWUgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICB7fVxuICAgICAgICApLFxuICAgICAgfSksXG4gICAgICB0cnVlLFxuICAgICAgdHJ1ZVxuICAgICk7XG5cbiAgICBwYXJzZUdyYXBoUUxTY2hlbWEuYWRkR3JhcGhRTE11dGF0aW9uKFxuICAgICAgJ2NhbGxDbG91ZENvZGUnLFxuICAgICAge1xuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICAnVGhlIGNhbGwgbXV0YXRpb24gY2FuIGJlIHVzZWQgdG8gaW52b2tlIGEgY2xvdWQgY29kZSBmdW5jdGlvbi4nLFxuICAgICAgICBhcmdzOiB7XG4gICAgICAgICAgZnVuY3Rpb25OYW1lOiB7XG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogJ1RoaXMgaXMgdGhlIGZ1bmN0aW9uIHRvIGJlIGNhbGxlZC4nLFxuICAgICAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKGNsb3VkQ29kZUZ1bmN0aW9uRW51bSksXG4gICAgICAgICAgfSxcbiAgICAgICAgICBwYXJhbXM6IHtcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnVGhlc2UgYXJlIHRoZSBwYXJhbXMgdG8gYmUgcGFzc2VkIHRvIHRoZSBmdW5jdGlvbi4nLFxuICAgICAgICAgICAgdHlwZTogZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1QsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgdHlwZTogZGVmYXVsdEdyYXBoUUxUeXBlcy5BTlksXG4gICAgICAgIGFzeW5jIHJlc29sdmUoX3NvdXJjZSwgYXJncywgY29udGV4dCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGZ1bmN0aW9uTmFtZSwgcGFyYW1zIH0gPSBhcmdzO1xuICAgICAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgICAgIHJldHVybiAoYXdhaXQgRnVuY3Rpb25zUm91dGVyLmhhbmRsZUNsb3VkRnVuY3Rpb24oe1xuICAgICAgICAgICAgICBwYXJhbXM6IHtcbiAgICAgICAgICAgICAgICBmdW5jdGlvbk5hbWUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgICAgaW5mbyxcbiAgICAgICAgICAgICAgYm9keTogcGFyYW1zLFxuICAgICAgICAgICAgfSkpLnJlc3BvbnNlLnJlc3VsdDtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBwYXJzZUdyYXBoUUxTY2hlbWEuaGFuZGxlRXJyb3IoZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHRydWUsXG4gICAgICB0cnVlXG4gICAgKTtcbiAgfVxufTtcblxuZXhwb3J0IHsgbG9hZCB9O1xuIl19