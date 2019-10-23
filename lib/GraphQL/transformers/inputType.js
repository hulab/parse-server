"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.transformInputTypeToGraphQL = void 0;

var _graphql = require("graphql");

var defaultGraphQLTypes = _interopRequireWildcard(require("../loaders/defaultGraphQLTypes"));

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

const transformInputTypeToGraphQL = (parseType, targetClass, parseClassTypes) => {
  switch (parseType) {
    case 'String':
      return _graphql.GraphQLString;

    case 'Number':
      return _graphql.GraphQLFloat;

    case 'Boolean':
      return _graphql.GraphQLBoolean;

    case 'Array':
      return new _graphql.GraphQLList(defaultGraphQLTypes.ANY);

    case 'Object':
      return defaultGraphQLTypes.OBJECT;

    case 'Date':
      return defaultGraphQLTypes.DATE;

    case 'Pointer':
      if (parseClassTypes && parseClassTypes[targetClass] && parseClassTypes[targetClass].classGraphQLPointerType) {
        return parseClassTypes[targetClass].classGraphQLPointerType;
      } else {
        return defaultGraphQLTypes.OBJECT;
      }

    case 'Relation':
      if (parseClassTypes && parseClassTypes[targetClass] && parseClassTypes[targetClass].classGraphQLRelationType) {
        return parseClassTypes[targetClass].classGraphQLRelationType;
      } else {
        return defaultGraphQLTypes.OBJECT;
      }

    case 'File':
      return defaultGraphQLTypes.FILE;

    case 'GeoPoint':
      return defaultGraphQLTypes.GEO_POINT_INPUT;

    case 'Polygon':
      return defaultGraphQLTypes.POLYGON_INPUT;

    case 'Bytes':
      return defaultGraphQLTypes.BYTES;

    case 'ACL':
      return defaultGraphQLTypes.OBJECT;

    default:
      return undefined;
  }
};

exports.transformInputTypeToGraphQL = transformInputTypeToGraphQL;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML3RyYW5zZm9ybWVycy9pbnB1dFR5cGUuanMiXSwibmFtZXMiOlsidHJhbnNmb3JtSW5wdXRUeXBlVG9HcmFwaFFMIiwicGFyc2VUeXBlIiwidGFyZ2V0Q2xhc3MiLCJwYXJzZUNsYXNzVHlwZXMiLCJHcmFwaFFMU3RyaW5nIiwiR3JhcGhRTEZsb2F0IiwiR3JhcGhRTEJvb2xlYW4iLCJHcmFwaFFMTGlzdCIsImRlZmF1bHRHcmFwaFFMVHlwZXMiLCJBTlkiLCJPQkpFQ1QiLCJEQVRFIiwiY2xhc3NHcmFwaFFMUG9pbnRlclR5cGUiLCJjbGFzc0dyYXBoUUxSZWxhdGlvblR5cGUiLCJGSUxFIiwiR0VPX1BPSU5UX0lOUFVUIiwiUE9MWUdPTl9JTlBVVCIsIkJZVEVTIiwidW5kZWZpbmVkIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBTUE7Ozs7QUFFQSxNQUFNQSwyQkFBMkIsR0FBRyxDQUNsQ0MsU0FEa0MsRUFFbENDLFdBRmtDLEVBR2xDQyxlQUhrQyxLQUkvQjtBQUNILFVBQVFGLFNBQVI7QUFDRSxTQUFLLFFBQUw7QUFDRSxhQUFPRyxzQkFBUDs7QUFDRixTQUFLLFFBQUw7QUFDRSxhQUFPQyxxQkFBUDs7QUFDRixTQUFLLFNBQUw7QUFDRSxhQUFPQyx1QkFBUDs7QUFDRixTQUFLLE9BQUw7QUFDRSxhQUFPLElBQUlDLG9CQUFKLENBQWdCQyxtQkFBbUIsQ0FBQ0MsR0FBcEMsQ0FBUDs7QUFDRixTQUFLLFFBQUw7QUFDRSxhQUFPRCxtQkFBbUIsQ0FBQ0UsTUFBM0I7O0FBQ0YsU0FBSyxNQUFMO0FBQ0UsYUFBT0YsbUJBQW1CLENBQUNHLElBQTNCOztBQUNGLFNBQUssU0FBTDtBQUNFLFVBQ0VSLGVBQWUsSUFDZkEsZUFBZSxDQUFDRCxXQUFELENBRGYsSUFFQUMsZUFBZSxDQUFDRCxXQUFELENBQWYsQ0FBNkJVLHVCQUgvQixFQUlFO0FBQ0EsZUFBT1QsZUFBZSxDQUFDRCxXQUFELENBQWYsQ0FBNkJVLHVCQUFwQztBQUNELE9BTkQsTUFNTztBQUNMLGVBQU9KLG1CQUFtQixDQUFDRSxNQUEzQjtBQUNEOztBQUNILFNBQUssVUFBTDtBQUNFLFVBQ0VQLGVBQWUsSUFDZkEsZUFBZSxDQUFDRCxXQUFELENBRGYsSUFFQUMsZUFBZSxDQUFDRCxXQUFELENBQWYsQ0FBNkJXLHdCQUgvQixFQUlFO0FBQ0EsZUFBT1YsZUFBZSxDQUFDRCxXQUFELENBQWYsQ0FBNkJXLHdCQUFwQztBQUNELE9BTkQsTUFNTztBQUNMLGVBQU9MLG1CQUFtQixDQUFDRSxNQUEzQjtBQUNEOztBQUNILFNBQUssTUFBTDtBQUNFLGFBQU9GLG1CQUFtQixDQUFDTSxJQUEzQjs7QUFDRixTQUFLLFVBQUw7QUFDRSxhQUFPTixtQkFBbUIsQ0FBQ08sZUFBM0I7O0FBQ0YsU0FBSyxTQUFMO0FBQ0UsYUFBT1AsbUJBQW1CLENBQUNRLGFBQTNCOztBQUNGLFNBQUssT0FBTDtBQUNFLGFBQU9SLG1CQUFtQixDQUFDUyxLQUEzQjs7QUFDRixTQUFLLEtBQUw7QUFDRSxhQUFPVCxtQkFBbUIsQ0FBQ0UsTUFBM0I7O0FBQ0Y7QUFDRSxhQUFPUSxTQUFQO0FBNUNKO0FBOENELENBbkREIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtcbiAgR3JhcGhRTFN0cmluZyxcbiAgR3JhcGhRTEZsb2F0LFxuICBHcmFwaFFMQm9vbGVhbixcbiAgR3JhcGhRTExpc3QsXG59IGZyb20gJ2dyYXBocWwnO1xuaW1wb3J0ICogYXMgZGVmYXVsdEdyYXBoUUxUeXBlcyBmcm9tICcuLi9sb2FkZXJzL2RlZmF1bHRHcmFwaFFMVHlwZXMnO1xuXG5jb25zdCB0cmFuc2Zvcm1JbnB1dFR5cGVUb0dyYXBoUUwgPSAoXG4gIHBhcnNlVHlwZSxcbiAgdGFyZ2V0Q2xhc3MsXG4gIHBhcnNlQ2xhc3NUeXBlc1xuKSA9PiB7XG4gIHN3aXRjaCAocGFyc2VUeXBlKSB7XG4gICAgY2FzZSAnU3RyaW5nJzpcbiAgICAgIHJldHVybiBHcmFwaFFMU3RyaW5nO1xuICAgIGNhc2UgJ051bWJlcic6XG4gICAgICByZXR1cm4gR3JhcGhRTEZsb2F0O1xuICAgIGNhc2UgJ0Jvb2xlYW4nOlxuICAgICAgcmV0dXJuIEdyYXBoUUxCb29sZWFuO1xuICAgIGNhc2UgJ0FycmF5JzpcbiAgICAgIHJldHVybiBuZXcgR3JhcGhRTExpc3QoZGVmYXVsdEdyYXBoUUxUeXBlcy5BTlkpO1xuICAgIGNhc2UgJ09iamVjdCc6XG4gICAgICByZXR1cm4gZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1Q7XG4gICAgY2FzZSAnRGF0ZSc6XG4gICAgICByZXR1cm4gZGVmYXVsdEdyYXBoUUxUeXBlcy5EQVRFO1xuICAgIGNhc2UgJ1BvaW50ZXInOlxuICAgICAgaWYgKFxuICAgICAgICBwYXJzZUNsYXNzVHlwZXMgJiZcbiAgICAgICAgcGFyc2VDbGFzc1R5cGVzW3RhcmdldENsYXNzXSAmJlxuICAgICAgICBwYXJzZUNsYXNzVHlwZXNbdGFyZ2V0Q2xhc3NdLmNsYXNzR3JhcGhRTFBvaW50ZXJUeXBlXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIHBhcnNlQ2xhc3NUeXBlc1t0YXJnZXRDbGFzc10uY2xhc3NHcmFwaFFMUG9pbnRlclR5cGU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1Q7XG4gICAgICB9XG4gICAgY2FzZSAnUmVsYXRpb24nOlxuICAgICAgaWYgKFxuICAgICAgICBwYXJzZUNsYXNzVHlwZXMgJiZcbiAgICAgICAgcGFyc2VDbGFzc1R5cGVzW3RhcmdldENsYXNzXSAmJlxuICAgICAgICBwYXJzZUNsYXNzVHlwZXNbdGFyZ2V0Q2xhc3NdLmNsYXNzR3JhcGhRTFJlbGF0aW9uVHlwZVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiBwYXJzZUNsYXNzVHlwZXNbdGFyZ2V0Q2xhc3NdLmNsYXNzR3JhcGhRTFJlbGF0aW9uVHlwZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBkZWZhdWx0R3JhcGhRTFR5cGVzLk9CSkVDVDtcbiAgICAgIH1cbiAgICBjYXNlICdGaWxlJzpcbiAgICAgIHJldHVybiBkZWZhdWx0R3JhcGhRTFR5cGVzLkZJTEU7XG4gICAgY2FzZSAnR2VvUG9pbnQnOlxuICAgICAgcmV0dXJuIGRlZmF1bHRHcmFwaFFMVHlwZXMuR0VPX1BPSU5UX0lOUFVUO1xuICAgIGNhc2UgJ1BvbHlnb24nOlxuICAgICAgcmV0dXJuIGRlZmF1bHRHcmFwaFFMVHlwZXMuUE9MWUdPTl9JTlBVVDtcbiAgICBjYXNlICdCeXRlcyc6XG4gICAgICByZXR1cm4gZGVmYXVsdEdyYXBoUUxUeXBlcy5CWVRFUztcbiAgICBjYXNlICdBQ0wnOlxuICAgICAgcmV0dXJuIGRlZmF1bHRHcmFwaFFMVHlwZXMuT0JKRUNUO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59O1xuXG5leHBvcnQgeyB0cmFuc2Zvcm1JbnB1dFR5cGVUb0dyYXBoUUwgfTtcbiJdfQ==