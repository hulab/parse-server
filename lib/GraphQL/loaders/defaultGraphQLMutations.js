"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.load = void 0;

var filesMutations = _interopRequireWildcard(require("./filesMutations"));

var usersMutations = _interopRequireWildcard(require("./usersMutations"));

var functionsMutations = _interopRequireWildcard(require("./functionsMutations"));

var schemaMutations = _interopRequireWildcard(require("./schemaMutations"));

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

const load = parseGraphQLSchema => {
  filesMutations.load(parseGraphQLSchema);
  usersMutations.load(parseGraphQLSchema);
  functionsMutations.load(parseGraphQLSchema);
  schemaMutations.load(parseGraphQLSchema);
};

exports.load = load;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2xvYWRlcnMvZGVmYXVsdEdyYXBoUUxNdXRhdGlvbnMuanMiXSwibmFtZXMiOlsibG9hZCIsInBhcnNlR3JhcGhRTFNjaGVtYSIsImZpbGVzTXV0YXRpb25zIiwidXNlcnNNdXRhdGlvbnMiLCJmdW5jdGlvbnNNdXRhdGlvbnMiLCJzY2hlbWFNdXRhdGlvbnMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTs7QUFDQTs7QUFDQTs7QUFDQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0Msa0JBQWtCLElBQUk7QUFDakNDLEVBQUFBLGNBQWMsQ0FBQ0YsSUFBZixDQUFvQkMsa0JBQXBCO0FBQ0FFLEVBQUFBLGNBQWMsQ0FBQ0gsSUFBZixDQUFvQkMsa0JBQXBCO0FBQ0FHLEVBQUFBLGtCQUFrQixDQUFDSixJQUFuQixDQUF3QkMsa0JBQXhCO0FBQ0FJLEVBQUFBLGVBQWUsQ0FBQ0wsSUFBaEIsQ0FBcUJDLGtCQUFyQjtBQUNELENBTEQiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBmaWxlc011dGF0aW9ucyBmcm9tICcuL2ZpbGVzTXV0YXRpb25zJztcbmltcG9ydCAqIGFzIHVzZXJzTXV0YXRpb25zIGZyb20gJy4vdXNlcnNNdXRhdGlvbnMnO1xuaW1wb3J0ICogYXMgZnVuY3Rpb25zTXV0YXRpb25zIGZyb20gJy4vZnVuY3Rpb25zTXV0YXRpb25zJztcbmltcG9ydCAqIGFzIHNjaGVtYU11dGF0aW9ucyBmcm9tICcuL3NjaGVtYU11dGF0aW9ucyc7XG5cbmNvbnN0IGxvYWQgPSBwYXJzZUdyYXBoUUxTY2hlbWEgPT4ge1xuICBmaWxlc011dGF0aW9ucy5sb2FkKHBhcnNlR3JhcGhRTFNjaGVtYSk7XG4gIHVzZXJzTXV0YXRpb25zLmxvYWQocGFyc2VHcmFwaFFMU2NoZW1hKTtcbiAgZnVuY3Rpb25zTXV0YXRpb25zLmxvYWQocGFyc2VHcmFwaFFMU2NoZW1hKTtcbiAgc2NoZW1hTXV0YXRpb25zLmxvYWQocGFyc2VHcmFwaFFMU2NoZW1hKTtcbn07XG5cbmV4cG9ydCB7IGxvYWQgfTtcbiJdfQ==