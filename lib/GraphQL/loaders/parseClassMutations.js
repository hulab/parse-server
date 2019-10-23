"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.load = void 0;

var _graphql = require("graphql");

var _graphqlListFields = _interopRequireDefault(require("graphql-list-fields"));

var defaultGraphQLTypes = _interopRequireWildcard(require("./defaultGraphQLTypes"));

var _parseGraphQLUtils = require("../parseGraphQLUtils");

var objectsMutations = _interopRequireWildcard(require("../helpers/objectsMutations"));

var objectsQueries = _interopRequireWildcard(require("../helpers/objectsQueries"));

var _ParseGraphQLController = require("../../Controllers/ParseGraphQLController");

var _className = require("../transformers/className");

var _mutation = require("../transformers/mutation");

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { keys.push.apply(keys, Object.getOwnPropertySymbols(object)); } if (enumerableOnly) keys = keys.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(source, true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const getOnlyRequiredFields = (updatedFields, selectedFieldsString, includedFieldsString, nativeObjectFields) => {
  const includedFields = includedFieldsString.split(',');
  const selectedFields = selectedFieldsString.split(',');
  const missingFields = selectedFields.filter(field => !updatedFields[field] && !nativeObjectFields.includes(field) || includedFields.includes(field)).join(',');

  if (!missingFields.length) {
    return {
      needGet: false,
      keys: ''
    };
  } else {
    return {
      needGet: true,
      keys: missingFields
    };
  }
};

const load = function (parseGraphQLSchema, parseClass, parseClassConfig) {
  const className = parseClass.className;
  const graphQLClassName = (0, _className.transformClassNameToGraphQL)(className);
  const {
    create: isCreateEnabled = true,
    update: isUpdateEnabled = true,
    destroy: isDestroyEnabled = true
  } = (0, _parseGraphQLUtils.getParseClassMutationConfig)(parseClassConfig);
  const {
    classGraphQLCreateType,
    classGraphQLUpdateType,
    classGraphQLOutputType
  } = parseGraphQLSchema.parseClassTypes[className];

  if (isCreateEnabled) {
    const createGraphQLMutationName = `create${graphQLClassName}`;
    parseGraphQLSchema.addGraphQLMutation(createGraphQLMutationName, {
      description: `The ${createGraphQLMutationName} mutation can be used to create a new object of the ${graphQLClassName} class.`,
      args: {
        fields: {
          description: 'These are the fields used to create the object.',
          type: classGraphQLCreateType || defaultGraphQLTypes.OBJECT
        }
      },
      type: new _graphql.GraphQLNonNull(classGraphQLOutputType || defaultGraphQLTypes.OBJECT),

      async resolve(_source, args, context, mutationInfo) {
        try {
          let {
            fields
          } = args;
          if (!fields) fields = {};
          const {
            config,
            auth,
            info
          } = context;
          const parseFields = await (0, _mutation.transformTypes)('create', fields, {
            className,
            parseGraphQLSchema,
            req: {
              config,
              auth,
              info
            }
          });
          const createdObject = await objectsMutations.createObject(className, parseFields, config, auth, info);
          const selectedFields = (0, _graphqlListFields.default)(mutationInfo);
          const {
            keys,
            include
          } = (0, _parseGraphQLUtils.extractKeysAndInclude)(selectedFields);
          const {
            keys: requiredKeys,
            needGet
          } = getOnlyRequiredFields(fields, keys, include, ['id', 'createdAt', 'updatedAt']);
          let optimizedObject = {};

          if (needGet) {
            optimizedObject = await objectsQueries.getObject(className, createdObject.objectId, requiredKeys, include, undefined, undefined, config, auth, info);
          }

          return _objectSpread({}, createdObject, {
            updatedAt: createdObject.createdAt
          }, fields, {}, optimizedObject);
        } catch (e) {
          parseGraphQLSchema.handleError(e);
        }
      }

    });
  }

  if (isUpdateEnabled) {
    const updateGraphQLMutationName = `update${graphQLClassName}`;
    parseGraphQLSchema.addGraphQLMutation(updateGraphQLMutationName, {
      description: `The ${updateGraphQLMutationName} mutation can be used to update an object of the ${graphQLClassName} class.`,
      args: {
        id: defaultGraphQLTypes.OBJECT_ID_ATT,
        fields: {
          description: 'These are the fields used to update the object.',
          type: classGraphQLUpdateType || defaultGraphQLTypes.OBJECT
        }
      },
      type: new _graphql.GraphQLNonNull(classGraphQLOutputType || defaultGraphQLTypes.OBJECT),

      async resolve(_source, args, context, mutationInfo) {
        try {
          const {
            id,
            fields
          } = args;
          const {
            config,
            auth,
            info
          } = context;
          const parseFields = await (0, _mutation.transformTypes)('update', fields, {
            className,
            parseGraphQLSchema,
            req: {
              config,
              auth,
              info
            }
          });
          const updatedObject = await objectsMutations.updateObject(className, id, parseFields, config, auth, info);
          const selectedFields = (0, _graphqlListFields.default)(mutationInfo);
          const {
            keys,
            include
          } = (0, _parseGraphQLUtils.extractKeysAndInclude)(selectedFields);
          const {
            keys: requiredKeys,
            needGet
          } = getOnlyRequiredFields(fields, keys, include, ['id', 'updatedAt']);
          let optimizedObject = {};

          if (needGet) {
            optimizedObject = await objectsQueries.getObject(className, id, requiredKeys, include, undefined, undefined, config, auth, info);
          }

          return _objectSpread({
            id
          }, updatedObject, {}, fields, {}, optimizedObject);
        } catch (e) {
          parseGraphQLSchema.handleError(e);
        }
      }

    });
  }

  if (isDestroyEnabled) {
    const deleteGraphQLMutationName = `delete${graphQLClassName}`;
    parseGraphQLSchema.addGraphQLMutation(deleteGraphQLMutationName, {
      description: `The ${deleteGraphQLMutationName} mutation can be used to delete an object of the ${graphQLClassName} class.`,
      args: {
        id: defaultGraphQLTypes.OBJECT_ID_ATT
      },
      type: new _graphql.GraphQLNonNull(classGraphQLOutputType || defaultGraphQLTypes.OBJECT),

      async resolve(_source, args, context, mutationInfo) {
        try {
          const {
            id
          } = args;
          const {
            config,
            auth,
            info
          } = context;
          const selectedFields = (0, _graphqlListFields.default)(mutationInfo);
          const {
            keys,
            include
          } = (0, _parseGraphQLUtils.extractKeysAndInclude)(selectedFields);
          let optimizedObject = {};
          const splitedKeys = keys.split(',');

          if (splitedKeys.length > 1 || splitedKeys[0] !== 'id') {
            optimizedObject = await objectsQueries.getObject(className, id, keys, include, undefined, undefined, config, auth, info);
          }

          await objectsMutations.deleteObject(className, id, config, auth, info);
          return _objectSpread({
            id
          }, optimizedObject);
        } catch (e) {
          parseGraphQLSchema.handleError(e);
        }
      }

    });
  }
};

exports.load = load;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2xvYWRlcnMvcGFyc2VDbGFzc011dGF0aW9ucy5qcyJdLCJuYW1lcyI6WyJnZXRPbmx5UmVxdWlyZWRGaWVsZHMiLCJ1cGRhdGVkRmllbGRzIiwic2VsZWN0ZWRGaWVsZHNTdHJpbmciLCJpbmNsdWRlZEZpZWxkc1N0cmluZyIsIm5hdGl2ZU9iamVjdEZpZWxkcyIsImluY2x1ZGVkRmllbGRzIiwic3BsaXQiLCJzZWxlY3RlZEZpZWxkcyIsIm1pc3NpbmdGaWVsZHMiLCJmaWx0ZXIiLCJmaWVsZCIsImluY2x1ZGVzIiwiam9pbiIsImxlbmd0aCIsIm5lZWRHZXQiLCJrZXlzIiwibG9hZCIsInBhcnNlR3JhcGhRTFNjaGVtYSIsInBhcnNlQ2xhc3MiLCJwYXJzZUNsYXNzQ29uZmlnIiwiY2xhc3NOYW1lIiwiZ3JhcGhRTENsYXNzTmFtZSIsImNyZWF0ZSIsImlzQ3JlYXRlRW5hYmxlZCIsInVwZGF0ZSIsImlzVXBkYXRlRW5hYmxlZCIsImRlc3Ryb3kiLCJpc0Rlc3Ryb3lFbmFibGVkIiwiY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZSIsImNsYXNzR3JhcGhRTFVwZGF0ZVR5cGUiLCJjbGFzc0dyYXBoUUxPdXRwdXRUeXBlIiwicGFyc2VDbGFzc1R5cGVzIiwiY3JlYXRlR3JhcGhRTE11dGF0aW9uTmFtZSIsImFkZEdyYXBoUUxNdXRhdGlvbiIsImRlc2NyaXB0aW9uIiwiYXJncyIsImZpZWxkcyIsInR5cGUiLCJkZWZhdWx0R3JhcGhRTFR5cGVzIiwiT0JKRUNUIiwiR3JhcGhRTE5vbk51bGwiLCJyZXNvbHZlIiwiX3NvdXJjZSIsImNvbnRleHQiLCJtdXRhdGlvbkluZm8iLCJjb25maWciLCJhdXRoIiwiaW5mbyIsInBhcnNlRmllbGRzIiwicmVxIiwiY3JlYXRlZE9iamVjdCIsIm9iamVjdHNNdXRhdGlvbnMiLCJjcmVhdGVPYmplY3QiLCJpbmNsdWRlIiwicmVxdWlyZWRLZXlzIiwib3B0aW1pemVkT2JqZWN0Iiwib2JqZWN0c1F1ZXJpZXMiLCJnZXRPYmplY3QiLCJvYmplY3RJZCIsInVuZGVmaW5lZCIsInVwZGF0ZWRBdCIsImNyZWF0ZWRBdCIsImUiLCJoYW5kbGVFcnJvciIsInVwZGF0ZUdyYXBoUUxNdXRhdGlvbk5hbWUiLCJpZCIsIk9CSkVDVF9JRF9BVFQiLCJ1cGRhdGVkT2JqZWN0IiwidXBkYXRlT2JqZWN0IiwiZGVsZXRlR3JhcGhRTE11dGF0aW9uTmFtZSIsInNwbGl0ZWRLZXlzIiwiZGVsZXRlT2JqZWN0Il0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBSUE7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7Ozs7Ozs7OztBQUVBLE1BQU1BLHFCQUFxQixHQUFHLENBQzVCQyxhQUQ0QixFQUU1QkMsb0JBRjRCLEVBRzVCQyxvQkFINEIsRUFJNUJDLGtCQUo0QixLQUt6QjtBQUNILFFBQU1DLGNBQWMsR0FBR0Ysb0JBQW9CLENBQUNHLEtBQXJCLENBQTJCLEdBQTNCLENBQXZCO0FBQ0EsUUFBTUMsY0FBYyxHQUFHTCxvQkFBb0IsQ0FBQ0ksS0FBckIsQ0FBMkIsR0FBM0IsQ0FBdkI7QUFDQSxRQUFNRSxhQUFhLEdBQUdELGNBQWMsQ0FDakNFLE1BRG1CLENBRWxCQyxLQUFLLElBQ0YsQ0FBQ1QsYUFBYSxDQUFDUyxLQUFELENBQWQsSUFBeUIsQ0FBQ04sa0JBQWtCLENBQUNPLFFBQW5CLENBQTRCRCxLQUE1QixDQUEzQixJQUNBTCxjQUFjLENBQUNNLFFBQWYsQ0FBd0JELEtBQXhCLENBSmdCLEVBTW5CRSxJQU5tQixDQU1kLEdBTmMsQ0FBdEI7O0FBT0EsTUFBSSxDQUFDSixhQUFhLENBQUNLLE1BQW5CLEVBQTJCO0FBQ3pCLFdBQU87QUFBRUMsTUFBQUEsT0FBTyxFQUFFLEtBQVg7QUFBa0JDLE1BQUFBLElBQUksRUFBRTtBQUF4QixLQUFQO0FBQ0QsR0FGRCxNQUVPO0FBQ0wsV0FBTztBQUFFRCxNQUFBQSxPQUFPLEVBQUUsSUFBWDtBQUFpQkMsTUFBQUEsSUFBSSxF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QSxjQUFJZ0UsV0FBVyxDQUFDekQsTUFBWixHQUFxQixDQUFyQixJQUEwQnlELFdBQVcsQ0FBQyxDQUFELENBQVgsS0FBbUIsSUFBakQsRUFBdUQ7QUFDckRmLFlBQUFBLGVBQWUsR0FBRyxNQUFNQyxjQUFjLENBQUNDLFNBQWYsQ0FDdEJyQyxTQURzQixFQUV0QjZDLEVBRnNCLEVBR3RCbEQsSUFIc0IsRUFJdEJzQyxPQUpzQixFQUt0Qk0sU0FMc0IsRUFNdEJBLFNBTnNCLEVBT3RCZCxNQVBzQixFQVF0QkMsSUFSc0IsRUFTdEJDLElBVHNCLENBQXhCO0FBV0Q7O0FBQ0QsZ0JBQU1JLGdCQUFnQixDQUFDb0IsWUFBakIsQ0FDSm5ELFNBREksRUFFSjZDLEVBRkksRUFHSnBCLE1BSEksRUFJSkMsSUFKSSxFQUtKQyxJQUxJLENBQU47QUFPQTtBQUFTa0IsWUFBQUE7QUFBVCxhQUFnQlYsZUFBaEI7QUFDRCxTQTdCRCxDQTZCRSxPQUFPTyxDQUFQLEVBQVU7QUFDVjdDLFVBQUFBLGtCQUFrQixDQUFDOEMsV0FBbkIsQ0FBK0JELENBQS9CO0FBQ0Q7QUFDRjs7QUF6QzhELEtBQWpFO0FBMkNEO0FBQ0YsQ0ExTUQiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBHcmFwaFFMTm9uTnVsbCB9IGZyb20gJ2dyYXBocWwnO1xuaW1wb3J0IGdldEZpZWxkTmFtZXMgZnJvbSAnZ3JhcGhxbC1saXN0LWZpZWxkcyc7XG5pbXBvcnQgKiBhcyBkZWZhdWx0R3JhcGhRTFR5cGVzIGZyb20gJy4vZGVmYXVsdEdyYXBoUUxUeXBlcyc7XG5pbXBvcnQge1xuICBleHRyYWN0S2V5c0FuZEluY2x1ZGUsXG4gIGdldFBhcnNlQ2xhc3NNdXRhdGlvbkNvbmZpZyxcbn0gZnJvbSAnLi4vcGFyc2VHcmFwaFFMVXRpbHMnO1xuaW1wb3J0ICogYXMgb2JqZWN0c011dGF0aW9ucyBmcm9tICcuLi9oZWxwZXJzL29iamVjdHNNdXRhdGlvbnMnO1xuaW1wb3J0ICogYXMgb2JqZWN0c1F1ZXJpZXMgZnJvbSAnLi4vaGVscGVycy9vYmplY3RzUXVlcmllcyc7XG5pbXBvcnQgeyBQYXJzZUdyYXBoUUxDbGFzc0NvbmZpZyB9IGZyb20gJy4uLy4uL0NvbnRyb2xsZXJzL1BhcnNlR3JhcGhRTENvbnRyb2xsZXInO1xuaW1wb3J0IHsgdHJhbnNmb3JtQ2xhc3NOYW1lVG9HcmFwaFFMIH0gZnJvbSAnLi4vdHJhbnNmb3JtZXJzL2NsYXNzTmFtZSc7XG5pbXBvcnQgeyB0cmFuc2Zvcm1UeXBlcyB9IGZyb20gJy4uL3RyYW5zZm9ybWVycy9tdXRhdGlvbic7XG5cbmNvbnN0IGdldE9ubHlSZXF1aXJlZEZpZWxkcyA9IChcbiAgdXBkYXRlZEZpZWxkcyxcbiAgc2VsZWN0ZWRGaWVsZHNTdHJpbmcsXG4gIGluY2x1ZGVkRmllbGRzU3RyaW5nLFxuICBuYXRpdmVPYmplY3RGaWVsZHNcbikgPT4ge1xuICBjb25zdCBpbmNsdWRlZEZpZWxkcyA9IGluY2x1ZGVkRmllbGRzU3RyaW5nLnNwbGl0KCcsJyk7XG4gIGNvbnN0IHNlbGVjdGVkRmllbGRzID0gc2VsZWN0ZWRGaWVsZHNTdHJpbmcuc3BsaXQoJywnKTtcbiAgY29uc3QgbWlzc2luZ0ZpZWxkcyA9IHNlbGVjdGVkRmllbGRzXG4gICAgLmZpbHRlcihcbiAgICAgIGZpZWxkID0+XG4gICAgICAgICghdXBkYXRlZEZpZWxkc1tmaWVsZF0gJiYgIW5hdGl2ZU9iamVjdEZpZWxkcy5pbmNsdWRlcyhmaWVsZCkpIHx8XG4gICAgICAgIGluY2x1ZGVkRmllbGRzLmluY2x1ZGVzKGZpZWxkKVxuICAgIClcbiAgICAuam9pbignLCcpO1xuICBpZiAoIW1pc3NpbmdGaWVsZHMubGVuZ3RoKSB7XG4gICAgcmV0dXJuIHsgbmVlZEdldDogZmFsc2UsIGtleXM6ICcnIH07XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHsgbmVlZEdldDogdHJ1ZSwga2V5czogbWlzc2luZ0ZpZWxkcyB9O1xuICB9XG59O1xuXG5jb25zdCBsb2FkID0gZnVuY3Rpb24oXG4gIHBhcnNlR3JhcGhRTFNjaGVtYSxcbiAgcGFyc2VDbGFzcyxcbiAgcGFyc2VDbGFzc0NvbmZpZzogP1BhcnNlR3JhcGhRTENsYXNzQ29uZmlnXG4pIHtcbiAgY29uc3QgY2xhc3NOYW1lID0gcGFyc2VDbGFzcy5jbGFzc05hbWU7XG4gIGNvbnN0IGdyYXBoUUxDbGFzc05hbWUgPSB0cmFuc2Zvcm1DbGFzc05hbWVUb0dyYXBoUUwoY2xhc3NOYW1lKTtcblxuICBjb25zdCB7XG4gICAgY3JlYXRlOiBpc0NyZWF0ZUVuYWJsZWQgPSB0cnVlLFxuICAgIHVwZGF0ZTogaXNVcGRhdGVFbmFibGVkID0gdHJ1ZSxcbiAgICBkZXN0cm95OiBpc0Rlc3Ryb3lFbmFibGVkID0gdHJ1ZSxcbiAgfSA9IGdldFBhcnNlQ2xhc3NNdXRhdGlvbkNvbmZpZyhwYXJzZUNsYXNzQ29uZmlnKTtcblxuICBjb25zdCB7XG4gICAgY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZSxcbiAgICBjbGFzc0dyYXBoUUxVcGRhdGVUeXBlLFxuICAgIGNsYXNzR3JhcGhRTE91dHB1dFR5cGUsXG4gIH0gPSBwYXJzZUdyYXBoUUxTY2hlbWEucGFyc2VDbGFzc1R5cGVzW2NsYXNzTmFtZV07XG5cbiAgaWYgKGlzQ3JlYXRlRW5hYmxlZCkge1xuICAgIGNvbnN0IGNyZWF0ZUdyYXBoUUxNdXRhdGlvbk5hbWUgPSBgY3JlYXRlJHtncmFwaFFMQ2xhc3NOYW1lfWA7XG4gICAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxNdXRhdGlvbihjcmVhdGVHcmFwaFFMTXV0YXRpb25OYW1lLCB7XG4gICAgICBkZXNjcmlwdGlvbjogYFRoZSAke2NyZWF0ZUdyYXBoUUxNdXRhdGlvbk5hbWV9IG11dGF0aW9uIGNhbiBiZSB1c2VkIHRvIGNyZWF0ZSBhIG5ldyBvYmplY3Qgb2YgdGhlICR7Z3JhcGhRTENsYXNzTmFtZX0gY2xhc3MuYCxcbiAgICAgIGFyZ3M6IHtcbiAgICAgICAgZmllbGRzOiB7XG4gICAgICAgICAgZGVzY3JpcHRpb246ICdUaGVzZSBhcmUgdGhlIGZpZWxkcyB1c2VkIHRvIGNyZWF0ZSB0aGUgb2JqZWN0LicsXG4gICAgICAgICAgdHlwZTogY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZSB8fCBkZWZhdWx0R3JhcGhRTFR5cGVzLk9CSkVDVCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB0eXBlOiBuZXcgR3JhcGhRTE5vbk51bGwoXG4gICAgICAgIGNsYXNzR3JhcGhRTE91dHB1dFR5cGUgfHwgZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1RcbiAgICAgICksXG4gICAgICBhc3luYyByZXNvbHZlKF9zb3VyY2UsIGFyZ3MsIGNvbnRleHQsIG11dGF0aW9uSW5mbykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGxldCB7IGZpZWxkcyB9ID0gYXJncztcbiAgICAgICAgICBpZiAoIWZpZWxkcykgZmllbGRzID0ge307XG4gICAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgICBjb25zdCBwYXJzZUZpZWxkcyA9IGF3YWl0IHRyYW5zZm9ybVR5cGVzKCdjcmVhdGUnLCBmaWVsZHMsIHtcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYSxcbiAgICAgICAgICAgIHJlcTogeyBjb25maWcsIGF1dGgsIGluZm8gfSxcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNvbnN0IGNyZWF0ZWRPYmplY3QgPSBhd2FpdCBvYmplY3RzTXV0YXRpb25zLmNyZWF0ZU9iamVjdChcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcnNlRmllbGRzLFxuICAgICAgICAgICAgY29uZmlnLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGluZm9cbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnN0IHNlbGVjdGVkRmllbGRzID0gZ2V0RmllbGROYW1lcyhtdXRhdGlvbkluZm8pO1xuICAgICAgICAgIGNvbnN0IHsga2V5cywgaW5jbHVkZSB9ID0gZXh0cmFjdEtleXNBbmRJbmNsdWRlKHNlbGVjdGVkRmllbGRzKTtcbiAgICAgICAgICBjb25zdCB7IGtleXM6IHJlcXVpcmVkS2V5cywgbmVlZEdldCB9ID0gZ2V0T25seVJlcXVpcmVkRmllbGRzKFxuICAgICAgICAgICAgZmllbGRzLFxuICAgICAgICAgICAga2V5cyxcbiAgICAgICAgICAgIGluY2x1ZGUsXG4gICAgICAgICAgICBbJ2lkJywgJ2NyZWF0ZWRBdCcsICd1cGRhdGVkQXQnXVxuICAgICAgICAgICk7XG4gICAgICAgICAgbGV0IG9wdGltaXplZE9iamVjdCA9IHt9O1xuICAgICAgICAgIGlmIChuZWVkR2V0KSB7XG4gICAgICAgICAgICBvcHRpbWl6ZWRPYmplY3QgPSBhd2FpdCBvYmplY3RzUXVlcmllcy5nZXRPYmplY3QoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgY3JlYXRlZE9iamVjdC5vYmplY3RJZCxcbiAgICAgICAgICAgICAgcmVxdWlyZWRLZXlzLFxuICAgICAgICAgICAgICBpbmNsdWRlLFxuICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgY29uZmlnLFxuICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICBpbmZvXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgLi4uY3JlYXRlZE9iamVjdCxcbiAgICAgICAgICAgIHVwZGF0ZWRBdDogY3JlYXRlZE9iamVjdC5jcmVhdGVkQXQsXG4gICAgICAgICAgICAuLi5maWVsZHMsXG4gICAgICAgICAgICAuLi5vcHRpbWl6ZWRPYmplY3QsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5oYW5kbGVFcnJvcihlKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGlmIChpc1VwZGF0ZUVuYWJsZWQpIHtcbiAgICBjb25zdCB1cGRhdGVHcmFwaFFMTXV0YXRpb25OYW1lID0gYHVwZGF0ZSR7Z3JhcGhRTENsYXNzTmFtZX1gO1xuICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMTXV0YXRpb24odXBkYXRlR3JhcGhRTE11dGF0aW9uTmFtZSwge1xuICAgICAgZGVzY3JpcHRpb246IGBUaGUgJHt1cGRhdGVHcmFwaFFMTXV0YXRpb25OYW1lfSBtdXRhdGlvbiBjYW4gYmUgdXNlZCB0byB1cGRhdGUgYW4gb2JqZWN0IG9mIHRoZSAke2dyYXBoUUxDbGFzc05hbWV9IGNsYXNzLmAsXG4gICAgICBhcmdzOiB7XG4gICAgICAgIGlkOiBkZWZhdWx0R3JhcGhRTFR5cGVzLk9CSkVDVF9JRF9BVFQsXG4gICAgICAgIGZpZWxkczoge1xuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnVGhlc2UgYXJlIHRoZSBmaWVsZHMgdXNlZCB0byB1cGRhdGUgdGhlIG9iamVjdC4nLFxuICAgICAgICAgIHR5cGU6IGNsYXNzR3JhcGhRTFVwZGF0ZVR5cGUgfHwgZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1QsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKFxuICAgICAgICBjbGFzc0dyYXBoUUxPdXRwdXRUeXBlIHx8IGRlZmF1bHRHcmFwaFFMVHlwZXMuT0JKRUNUXG4gICAgICApLFxuICAgICAgYXN5bmMgcmVzb2x2ZShfc291cmNlLCBhcmdzLCBjb250ZXh0LCBtdXRhdGlvbkluZm8pIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCB7IGlkLCBmaWVsZHMgfSA9IGFyZ3M7XG4gICAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgICBjb25zdCBwYXJzZUZpZWxkcyA9IGF3YWl0IHRyYW5zZm9ybVR5cGVzKCd1cGRhdGUnLCBmaWVsZHMsIHtcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYSxcbiAgICAgICAgICAgIHJlcTogeyBjb25maWcsIGF1dGgsIGluZm8gfSxcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNvbnN0IHVwZGF0ZWRPYmplY3QgPSBhd2FpdCBvYmplY3RzTXV0YXRpb25zLnVwZGF0ZU9iamVjdChcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgcGFyc2VGaWVsZHMsXG4gICAgICAgICAgICBjb25maWcsXG4gICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgaW5mb1xuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3Qgc2VsZWN0ZWRGaWVsZHMgPSBnZXRGaWVsZE5hbWVzKG11dGF0aW9uSW5mbyk7XG4gICAgICAgICAgY29uc3QgeyBrZXlzLCBpbmNsdWRlIH0gPSBleHRyYWN0S2V5c0FuZEluY2x1ZGUoc2VsZWN0ZWRGaWVsZHMpO1xuXG4gICAgICAgICAgY29uc3QgeyBrZXlzOiByZXF1aXJlZEtleXMsIG5lZWRHZXQgfSA9IGdldE9ubHlSZXF1aXJlZEZpZWxkcyhcbiAgICAgICAgICAgIGZpZWxkcyxcbiAgICAgICAgICAgIGtleXMsXG4gICAgICAgICAgICBpbmNsdWRlLFxuICAgICAgICAgICAgWydpZCcsICd1cGRhdGVkQXQnXVxuICAgICAgICAgICk7XG4gICAgICAgICAgbGV0IG9wdGltaXplZE9iamVjdCA9IHt9O1xuICAgICAgICAgIGlmIChuZWVkR2V0KSB7XG4gICAgICAgICAgICBvcHRpbWl6ZWRPYmplY3QgPSBhd2FpdCBvYmplY3RzUXVlcmllcy5nZXRPYmplY3QoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgaWQsXG4gICAgICAgICAgICAgIHJlcXVpcmVkS2V5cyxcbiAgICAgICAgICAgICAgaW5jbHVkZSxcbiAgICAgICAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgICAgaW5mb1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgLi4udXBkYXRlZE9iamVjdCxcbiAgICAgICAgICAgIC4uLmZpZWxkcyxcbiAgICAgICAgICAgIC4uLm9wdGltaXplZE9iamVjdCxcbiAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcGFyc2VHcmFwaFFMU2NoZW1hLmhhbmRsZUVycm9yKGUpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKGlzRGVzdHJveUVuYWJsZWQpIHtcbiAgICBjb25zdCBkZWxldGVHcmFwaFFMTXV0YXRpb25OYW1lID0gYGRlbGV0ZSR7Z3JhcGhRTENsYXNzTmFtZX1gO1xuICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMTXV0YXRpb24oZGVsZXRlR3JhcGhRTE11dGF0aW9uTmFtZSwge1xuICAgICAgZGVzY3JpcHRpb246IGBUaGUgJHtkZWxldGVHcmFwaFFMTXV0YXRpb25OYW1lfSBtdXRhdGlvbiBjYW4gYmUgdXNlZCB0byBkZWxldGUgYW4gb2JqZWN0IG9mIHRoZSAke2dyYXBoUUxDbGFzc05hbWV9IGNsYXNzLmAsXG4gICAgICBhcmdzOiB7XG4gICAgICAgIGlkOiBkZWZhdWx0R3JhcGhRTFR5cGVzLk9CSkVDVF9JRF9BVFQsXG4gICAgICB9LFxuICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKFxuICAgICAgICBjbGFzc0dyYXBoUUxPdXRwdXRUeXBlIHx8IGRlZmF1bHRHcmFwaFFMVHlwZXMuT0JKRUNUXG4gICAgICApLFxuICAgICAgYXN5bmMgcmVzb2x2ZShfc291cmNlLCBhcmdzLCBjb250ZXh0LCBtdXRhdGlvbkluZm8pIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCB7IGlkIH0gPSBhcmdzO1xuICAgICAgICAgIGNvbnN0IHsgY29uZmlnLCBhdXRoLCBpbmZvIH0gPSBjb250ZXh0O1xuICAgICAgICAgIGNvbnN0IHNlbGVjdGVkRmllbGRzID0gZ2V0RmllbGROYW1lcyhtdXRhdGlvbkluZm8pO1xuICAgICAgICAgIGNvbnN0IHsga2V5cywgaW5jbHVkZSB9ID0gZXh0cmFjdEtleXNBbmRJbmNsdWRlKHNlbGVjdGVkRmllbGRzKTtcblxuICAgICAgICAgIGxldCBvcHRpbWl6ZWRPYmplY3QgPSB7fTtcbiAgICAgICAgICBjb25zdCBzcGxpdGVkS2V5cyA9IGtleXMuc3BsaXQoJywnKTtcbiAgICAgICAgICBpZiAoc3BsaXRlZEtleXMubGVuZ3RoID4gMSB8fCBzcGxpdGVkS2V5c1swXSAhPT0gJ2lkJykge1xuICAgICAgICAgICAgb3B0aW1pemVkT2JqZWN0ID0gYXdhaXQgb2JqZWN0c1F1ZXJpZXMuZ2V0T2JqZWN0KFxuICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgICBrZXlzLFxuICAgICAgICAgICAgICBpbmNsdWRlLFxuICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgY29uZmlnLFxuICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICBpbmZvXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBhd2FpdCBvYmplY3RzTXV0YXRpb25zLmRlbGV0ZU9iamVjdChcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgY29uZmlnLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGluZm9cbiAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybiB7IGlkLCAuLi5vcHRpbWl6ZWRPYmplY3QgfTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5oYW5kbGVFcnJvcihlKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxufTtcblxuZXhwb3J0IHsgbG9hZCB9O1xuIl19