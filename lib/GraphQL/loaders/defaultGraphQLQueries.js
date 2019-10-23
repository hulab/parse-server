"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.load = void 0;

var _graphql = require("graphql");

var usersQueries = _interopRequireWildcard(require("./usersQueries"));

var schemaQueries = _interopRequireWildcard(require("./schemaQueries"));

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

const load = parseGraphQLSchema => {
  parseGraphQLSchema.addGraphQLQuery('health', {
    description: 'The health query can be used to check if the server is up and running.',
    type: new _graphql.GraphQLNonNull(_graphql.GraphQLBoolean),
    resolve: () => true
  }, true, true);
  usersQueries.load(parseGraphQLSchema);
  schemaQueries.load(parseGraphQLSchema);
};

exports.load = load;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2xvYWRlcnMvZGVmYXVsdEdyYXBoUUxRdWVyaWVzLmpzIl0sIm5hbWVzIjpbImxvYWQiLCJwYXJzZUdyYXBoUUxTY2hlbWEiLCJhZGRHcmFwaFFMUXVlcnkiLCJkZXNjcmlwdGlvbiIsInR5cGUiLCJHcmFwaFFMTm9uTnVsbCIsIkdyYXBoUUxCb29sZWFuIiwicmVzb2x2ZSIsInVzZXJzUXVlcmllcyIsInNjaGVtYVF1ZXJpZXMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTs7QUFDQTs7QUFDQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0Msa0JBQWtCLElBQUk7QUFDakNBLEVBQUFBLGtCQUFrQixDQUFDQyxlQUFuQixDQUNFLFFBREYsRUFFRTtBQUNFQyxJQUFBQSxXQUFXLEVBQ1Qsd0VBRko7QUFHRUMsSUFBQUEsSUFBSSxFQUFFLElBQUlDLHVCQUFKLENBQW1CQyx1QkFBbkIsQ0FIUjtBQUlFQyxJQUFBQSxPQUFPLEVBQUUsTUFBTTtBQUpqQixHQUZGLEVBUUUsSUFSRixFQVNFLElBVEY7QUFZQUMsRUFBQUEsWUFBWSxDQUFDUixJQUFiLENBQWtCQyxrQkFBbEI7QUFDQVEsRUFBQUEsYUFBYSxDQUFDVCxJQUFkLENBQW1CQyxrQkFBbkI7QUFDRCxDQWZEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgR3JhcGhRTE5vbk51bGwsIEdyYXBoUUxCb29sZWFuIH0gZnJvbSAnZ3JhcGhxbCc7XG5pbXBvcnQgKiBhcyB1c2Vyc1F1ZXJpZXMgZnJvbSAnLi91c2Vyc1F1ZXJpZXMnO1xuaW1wb3J0ICogYXMgc2NoZW1hUXVlcmllcyBmcm9tICcuL3NjaGVtYVF1ZXJpZXMnO1xuXG5jb25zdCBsb2FkID0gcGFyc2VHcmFwaFFMU2NoZW1hID0+IHtcbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxRdWVyeShcbiAgICAnaGVhbHRoJyxcbiAgICB7XG4gICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgJ1RoZSBoZWFsdGggcXVlcnkgY2FuIGJlIHVzZWQgdG8gY2hlY2sgaWYgdGhlIHNlcnZlciBpcyB1cCBhbmQgcnVubmluZy4nLFxuICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKEdyYXBoUUxCb29sZWFuKSxcbiAgICAgIHJlc29sdmU6ICgpID0+IHRydWUsXG4gICAgfSxcbiAgICB0cnVlLFxuICAgIHRydWVcbiAgKTtcblxuICB1c2Vyc1F1ZXJpZXMubG9hZChwYXJzZUdyYXBoUUxTY2hlbWEpO1xuICBzY2hlbWFRdWVyaWVzLmxvYWQocGFyc2VHcmFwaFFMU2NoZW1hKTtcbn07XG5cbmV4cG9ydCB7IGxvYWQgfTtcbiJdfQ==