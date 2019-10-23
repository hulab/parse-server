"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.load = exports.getClass = void 0;

var _node = _interopRequireDefault(require("parse/node"));

var _graphql = require("graphql");

var _schemaFields = require("../transformers/schemaFields");

var schemaTypes = _interopRequireWildcard(require("./schemaTypes"));

var _parseGraphQLUtils = require("../parseGraphQLUtils");

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const getClass = async (name, schema) => {
  try {
    return await schema.getOneSchema(name, true);
  } catch (e) {
    if (e === undefined) {
      throw new _node.default.Error(_node.default.Error.INVALID_CLASS_NAME, `Class ${name} does not exist.`);
    } else {
      throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'Database adapter error.');
    }
  }
};

exports.getClass = getClass;

const load = parseGraphQLSchema => {
  parseGraphQLSchema.addGraphQLQuery('class', {
    description: 'The class query can be used to retrieve an existing object class.',
    args: {
      name: schemaTypes.CLASS_NAME_ATT
    },
    type: new _graphql.GraphQLNonNull(schemaTypes.CLASS),
    resolve: async (_source, args, context) => {
      try {
        const {
          name
        } = args;
        const {
          config,
          auth
        } = context;
        (0, _parseGraphQLUtils.enforceMasterKeyAccess)(auth);
        const schema = await config.database.loadSchema({
          clearCache: true
        });
        const parseClass = await getClass(name, schema);
        return {
          name: parseClass.className,
          schemaFields: (0, _schemaFields.transformToGraphQL)(parseClass.fields)
        };
      } catch (e) {
        parseGraphQLSchema.handleError(e);
      }
    }
  }, true, true);
  parseGraphQLSchema.addGraphQLQuery('classes', {
    description: 'The classes query can be used to retrieve the existing object classes.',
    type: new _graphql.GraphQLNonNull(new _graphql.GraphQLList(new _graphql.GraphQLNonNull(schemaTypes.CLASS))),
    resolve: async (_source, _args, context) => {
      try {
        const {
          config,
          auth
        } = context;
        (0, _parseGraphQLUtils.enforceMasterKeyAccess)(auth);
        const schema = await config.database.loadSchema({
          clearCache: true
        });
        return (await schema.getAllClasses(true)).map(parseClass => ({
          name: parseClass.className,
          schemaFields: (0, _schemaFields.transformToGraphQL)(parseClass.fields)
        }));
      } catch (e) {
        parseGraphQLSchema.handleError(e);
      }
    }
  }, true, true);
};

exports.load = load;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2xvYWRlcnMvc2NoZW1hUXVlcmllcy5qcyJdLCJuYW1lcyI6WyJnZXRDbGFzcyIsIm5hbWUiLCJzY2hlbWEiLCJnZXRPbmVTY2hlbWEiLCJlIiwidW5kZWZpbmVkIiwiUGFyc2UiLCJFcnJvciIsIklOVkFMSURfQ0xBU1NfTkFNRSIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsImxvYWQiLCJwYXJzZUdyYXBoUUxTY2hlbWEiLCJhZGRHcmFwaFFMUXVlcnkiLCJkZXNjcmlwdGlvbiIsImFyZ3MiLCJzY2hlbWFUeXBlcyIsIkNMQVNTX05BTUVfQVRUIiwidHlwZSIsIkdyYXBoUUxOb25OdWxsIiwiQ0xBU1MiLCJyZXNvbHZlIiwiX3NvdXJjZSIsImNvbnRleHQiLCJjb25maWciLCJhdXRoIiwiZGF0YWJhc2UiLCJsb2FkU2NoZW1hIiwiY2xlYXJDYWNoZSIsInBhcnNlQ2xhc3MiLCJjbGFzc05hbWUiLCJzY2hlbWFGaWVsZHMiLCJmaWVsZHMiLCJoYW5kbGVFcnJvciIsIkdyYXBoUUxMaXN0IiwiX2FyZ3MiLCJnZXRBbGxDbGFzc2VzIiwibWFwIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7OztBQUVBLE1BQU1BLFFBQVEsR0FBRyxPQUFPQyxJQUFQLEVBQWFDLE1BQWIsS0FBd0I7QUFDdkMsTUFBSTtBQUNGLFdBQU8sTUFBTUEsTUFBTSxDQUFDQyxZQUFQLENBQW9CRixJQUFwQixFQUEwQixJQUExQixDQUFiO0FBQ0QsR0FGRCxDQUVFLE9BQU9HLENBQVAsRUFBVTtBQUNWLFFBQUlBLENBQUMsS0FBS0MsU0FBVixFQUFxQjtBQUNuQixZQUFNLElBQUlDLGNBQU1DLEtBQVYsQ0FDSkQsY0FBTUMsS0FBTixDQUFZQyxrQkFEUixFQUVILFNBQVFQLElBQUssa0JBRlYsQ0FBTjtBQUlELEtBTEQsTUFLTztBQUNMLFlBQU0sSUFBSUssY0FBTUMsS0FBVixDQUNKRCxjQUFNQyxLQUFOLENBQVlFLHFCQURSLEVBRUoseUJBRkksQ0FBTjtBQUlEO0FBQ0Y7QUFDRixDQWhCRDs7OztBQWtCQSxNQUFNQyxJQUFJLEdBQUdDLGtCQUFrQixJQUFJO0FBQ2pDQSxFQUFBQSxrQkFBa0IsQ0FBQ0MsZUFBbkIsQ0FDRSxPQURGLEVBRUU7QUFDRUMsSUFBQUEsV0FBVyxFQUNULG1FQUZKO0FBR0VDLElBQUFBLElBQUksRUFBRTtBQUNKYixNQUFBQSxJQUFJLEVBQUVjLFdBQVcsQ0FBQ0M7QUFEZCxLQUhSO0FBTUVDLElBQUFBLElBQUksRUFBRSxJQUFJQyx1QkFBSixDQUFtQkgsV0FBVyxDQUFDSSxLQUEvQixDQU5SO0FBT0VDLElBQUFBLE9BQU8sRUFBRSxPQUFPQyxPQUFQLEVBQWdCUCxJQUFoQixFQUFzQlEsT0FBdEIsS0FBa0M7QUFDekMsVUFBSTtBQUNGLGNBQU07QUFBRXJCLFVBQUFBO0FBQUYsWUFBV2EsSUFBakI7QUFDQSxjQUFNO0FBQUVTLFVBQUFBLE1BQUY7QUFBVUMsVUFBQUE7QUFBVixZQUFtQkYsT0FBekI7QUFFQSx1REFBdUJFLElBQXZCO0FBRUEsY0FBTXRCLE1BQU0sR0FBRyxNQUFNcUIsTUFBTSxDQUFDRSxRQUFQLENBQWdCQyxVQUFoQixDQUEyQjtBQUFFQyxVQUFBQSxVQUFVLEVBQUU7QUFBZCxTQUEzQixDQUFyQjtBQUNBLGNBQU1DLFVBQVUsR0FBRyxNQUFNNUIsUUFBUSxDQUFDQyxJQUFELEVBQU9DLE1BQVAsQ0FBakM7QUFDQSxlQUFPO0FBQ0xELFVBQUFBLElBQUksRUFBRTJCLFVBQVUsQ0FBQ0MsU0FEWjtBQUVMQyxVQUFBQSxZQUFZLEVBQUUsc0NBQW1CRixVQUFVLENBQUNHLE1BQTlCO0FBRlQsU0FBUDtBQUlELE9BWkQsQ0FZRSxPQUFPM0IsQ0FBUCxFQUFVO0FBQ1ZPLFFBQUFBLGtCQUFrQixDQUFDcUIsV0FBbkIsQ0FBK0I1QixDQUEvQjtBQUNEO0FBQ0Y7QUF2QkgsR0FGRixFQTJCRSxJQTNCRixFQTRCRSxJQTVCRjtBQStCQU8sRUFBQUEsa0JBQWtCLENBQUNDLGVBQW5CLENBQ0UsU0FERixFQUVFO0FBQ0VDLElBQUFBLFdBQVcsRUFDVCx3RUFGSjtBQUdFSSxJQUFBQSxJQUFJLEVBQUUsSUFBSUMsdUJBQUosQ0FDSixJQUFJZSxvQkFBSixDQUFnQixJQUFJZix1QkFBSixDQUFtQkgsV0FBVyxDQUFDSSxLQUEvQixDQUFoQixDQURJLENBSFI7QUFNRUMsSUFBQUEsT0FBTyxFQUFFLE9BQU9DLE9BQVAsRUFBZ0JhLEtBQWhCLEVBQXVCWixPQUF2QixLQUFtQztBQUMxQyxVQUFJO0FBQ0YsY0FBTTtBQUFFQyxVQUFBQSxNQUFGO0FBQVVDLFVBQUFBO0FBQVYsWUFBbUJGLE9BQXpCO0FBRUEsdURBQXVCRSxJQUF2QjtBQUVBLGNBQU10QixNQUFNLEdBQUcsTUFBTXFCLE1BQU0sQ0FBQ0UsUUFBUCxDQUFnQkMsVUFBaEIsQ0FBMkI7QUFBRUMsVUFBQUEsVUFBVSxFQUFFO0FBQWQsU0FBM0IsQ0FBckI7QUFDQSxlQUFPLENBQUMsTUFBTXpCLE1BQU0sQ0FBQ2lDLGFBQVAsQ0FBcUIsSUFBckIsQ0FBUCxFQUFtQ0MsR0FBbkMsQ0FBdUNSLFVBQVUsS0FBSztBQUMzRDNCLFVBQUFBLElBQUksRUFBRTJCLFVBQVUsQ0FBQ0MsU0FEMEM7QUFFM0RDLFVBQUFBLFlBQVksRUFBRSxzQ0FBbUJGLFVBQVUsQ0FBQ0csTUFBOUI7QUFGNkMsU0FBTCxDQUFqRCxDQUFQO0FBSUQsT0FWRCxDQVVFLE9BQU8zQixDQUFQLEVBQVU7QUFDVk8sUUFBQUEsa0JBQWtCLENBQUNxQixXQUFuQixDQUErQjVCLENBQS9CO0FBQ0Q7QUFDRjtBQXBCSCxHQUZGLEVBd0JFLElBeEJGLEVBeUJFLElBekJGO0FBMkJELENBM0REIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgR3JhcGhRTE5vbk51bGwsIEdyYXBoUUxMaXN0IH0gZnJvbSAnZ3JhcGhxbCc7XG5pbXBvcnQgeyB0cmFuc2Zvcm1Ub0dyYXBoUUwgfSBmcm9tICcuLi90cmFuc2Zvcm1lcnMvc2NoZW1hRmllbGRzJztcbmltcG9ydCAqIGFzIHNjaGVtYVR5cGVzIGZyb20gJy4vc2NoZW1hVHlwZXMnO1xuaW1wb3J0IHsgZW5mb3JjZU1hc3RlcktleUFjY2VzcyB9IGZyb20gJy4uL3BhcnNlR3JhcGhRTFV0aWxzJztcblxuY29uc3QgZ2V0Q2xhc3MgPSBhc3luYyAobmFtZSwgc2NoZW1hKSA9PiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IHNjaGVtYS5nZXRPbmVTY2hlbWEobmFtZSwgdHJ1ZSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfQ0xBU1NfTkFNRSxcbiAgICAgICAgYENsYXNzICR7bmFtZX0gZG9lcyBub3QgZXhpc3QuYFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAgICdEYXRhYmFzZSBhZGFwdGVyIGVycm9yLidcbiAgICAgICk7XG4gICAgfVxuICB9XG59O1xuXG5jb25zdCBsb2FkID0gcGFyc2VHcmFwaFFMU2NoZW1hID0+IHtcbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxRdWVyeShcbiAgICAnY2xhc3MnLFxuICAgIHtcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAnVGhlIGNsYXNzIHF1ZXJ5IGNhbiBiZSB1c2VkIHRvIHJldHJpZXZlIGFuIGV4aXN0aW5nIG9iamVjdCBjbGFzcy4nLFxuICAgICAgYXJnczoge1xuICAgICAgICBuYW1lOiBzY2hlbWFUeXBlcy5DTEFTU19OQU1FX0FUVCxcbiAgICAgIH0sXG4gICAgICB0eXBlOiBuZXcgR3JhcGhRTE5vbk51bGwoc2NoZW1hVHlwZXMuQ0xBU1MpLFxuICAgICAgcmVzb2x2ZTogYXN5bmMgKF9zb3VyY2UsIGFyZ3MsIGNvbnRleHQpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCB7IG5hbWUgfSA9IGFyZ3M7XG4gICAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGggfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgICBlbmZvcmNlTWFzdGVyS2V5QWNjZXNzKGF1dGgpO1xuXG4gICAgICAgICAgY29uc3Qgc2NoZW1hID0gYXdhaXQgY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoeyBjbGVhckNhY2hlOiB0cnVlIH0pO1xuICAgICAgICAgIGNvbnN0IHBhcnNlQ2xhc3MgPSBhd2FpdCBnZXRDbGFzcyhuYW1lLCBzY2hlbWEpO1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBuYW1lOiBwYXJzZUNsYXNzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHNjaGVtYUZpZWxkczogdHJhbnNmb3JtVG9HcmFwaFFMKHBhcnNlQ2xhc3MuZmllbGRzKSxcbiAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcGFyc2VHcmFwaFFMU2NoZW1hLmhhbmRsZUVycm9yKGUpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH0sXG4gICAgdHJ1ZSxcbiAgICB0cnVlXG4gICk7XG5cbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxRdWVyeShcbiAgICAnY2xhc3NlcycsXG4gICAge1xuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICdUaGUgY2xhc3NlcyBxdWVyeSBjYW4gYmUgdXNlZCB0byByZXRyaWV2ZSB0aGUgZXhpc3Rpbmcgb2JqZWN0IGNsYXNzZXMuJyxcbiAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChcbiAgICAgICAgbmV3IEdyYXBoUUxMaXN0KG5ldyBHcmFwaFFMTm9uTnVsbChzY2hlbWFUeXBlcy5DTEFTUykpXG4gICAgICApLFxuICAgICAgcmVzb2x2ZTogYXN5bmMgKF9zb3VyY2UsIF9hcmdzLCBjb250ZXh0KSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGggfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgICBlbmZvcmNlTWFzdGVyS2V5QWNjZXNzKGF1dGgpO1xuXG4gICAgICAgICAgY29uc3Qgc2NoZW1hID0gYXdhaXQgY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoeyBjbGVhckNhY2hlOiB0cnVlIH0pO1xuICAgICAgICAgIHJldHVybiAoYXdhaXQgc2NoZW1hLmdldEFsbENsYXNzZXModHJ1ZSkpLm1hcChwYXJzZUNsYXNzID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBwYXJzZUNsYXNzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHNjaGVtYUZpZWxkczogdHJhbnNmb3JtVG9HcmFwaFFMKHBhcnNlQ2xhc3MuZmllbGRzKSxcbiAgICAgICAgICB9KSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwYXJzZUdyYXBoUUxTY2hlbWEuaGFuZGxlRXJyb3IoZSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfSxcbiAgICB0cnVlLFxuICAgIHRydWVcbiAgKTtcbn07XG5cbmV4cG9ydCB7IGdldENsYXNzLCBsb2FkIH07XG4iXX0=