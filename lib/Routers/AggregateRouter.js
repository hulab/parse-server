'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.AggregateRouter = undefined;

var _ClassesRouter = require('./ClassesRouter');

var _ClassesRouter2 = _interopRequireDefault(_ClassesRouter);

var _rest = require('../rest');

var _rest2 = _interopRequireDefault(_rest);

var _middlewares = require('../middlewares');

var middleware = _interopRequireWildcard(_middlewares);

var _node = require('parse/node');

var _node2 = _interopRequireDefault(_node);

var _UsersRouter = require('./UsersRouter');

var _UsersRouter2 = _interopRequireDefault(_UsersRouter);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const BASE_KEYS = ['where', 'distinct', 'pipeline'];

const PIPELINE_KEYS = ['addFields', 'bucket', 'bucketAuto', 'collStats', 'count', 'currentOp', 'facet', 'geoNear', 'graphLookup', 'group', 'indexStats', 'limit', 'listLocalSessions', 'listSessions', 'lookup', 'match', 'out', 'project', 'redact', 'replaceRoot', 'sample', 'skip', 'sort', 'sortByCount', 'unwind'];

const ALLOWED_KEYS = [...BASE_KEYS, ...PIPELINE_KEYS];

class AggregateRouter extends _ClassesRouter2.default {

  handleFind(req) {
    const body = Object.assign(req.body, _ClassesRouter2.default.JSONFromQuery(req.query));
    const options = {};
    if (body.distinct) {
      options.distinct = String(body.distinct);
    }
    options.pipeline = AggregateRouter.getPipeline(body);
    if (typeof body.where === 'string') {
      body.where = JSON.parse(body.where);
    }
    return _rest2.default.find(req.config, req.auth, this.className(req), body.where, options, req.info.clientSDK).then(response => {
      for (const result of response.results) {
        if (typeof result === 'object') {
          _UsersRouter2.default.removeHiddenProperties(result);
        }
      }
      return { response };
    });
  }

  /* Builds a pipeline from the body. Originally the body could be passed as a single object,
   * and now we support many options
   *
   * Array
   *
   * body: [{
   *   group: { objectId: '$name' },
   * }]
   *
   * Object
   *
   * body: {
   *   group: { objectId: '$name' },
   * }
   *
   *
   * Pipeline Operator with an Array or an Object
   *
   * body: {
   *   pipeline: {
   *     group: { objectId: '$name' },
   *   }
   * }
   *
   */
  static getPipeline(body) {
    let pipeline = body.pipeline || body;

    if (!Array.isArray(pipeline)) {
      pipeline = Object.keys(pipeline).map(key => {
        return { [key]: pipeline[key] };
      });
    }

    return pipeline.map(stage => {
      const keys = Object.keys(stage);
      if (keys.length != 1) {
        throw new Error(`Pipeline stages should only have one key found ${keys.join(', ')}`);
      }
      return AggregateRouter.transformStage(keys[0], stage);
    });
  }

  static transformStage(stageName, stage) {
    if (ALLOWED_KEYS.indexOf(stageName) === -1) {
      throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Invalid parameter for query: ${stageName}`);
    }
    if (stageName === 'group') {
      if (stage[stageName].hasOwnProperty('_id')) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Invalid parameter for query: group. Please use objectId instead of _id`);
      }
      if (!stage[stageName].hasOwnProperty('objectId')) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Invalid parameter for query: group. objectId is required`);
      }
      stage[stageName]._id = stage[stageName].objectId;
      delete stage[stageName].objectId;
    }
    return { [`$${stageName}`]: stage[stageName] };
  }

  mountRoutes() {
    this.route('GET', '/aggregate/:className', middleware.promiseEnforceMasterKeyAccess, req => {
      return this.handleFind(req);
    });
  }
}

exports.AggregateRouter = AggregateRouter;
exports.default = AggregateRouter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Sb3V0ZXJzL0FnZ3JlZ2F0ZVJvdXRlci5qcyJdLCJuYW1lcyI6WyJtaWRkbGV3YXJlIiwiQkFTRV9LRVlTIiwiUElQRUxJTkVfS0VZUyIsIkFMTE9XRURfS0VZUyIsIkFnZ3JlZ2F0ZVJvdXRlciIsIkNsYXNzZXNSb3V0ZXIiLCJoYW5kbGVGaW5kIiwicmVxIiwiYm9keSIsIk9iamVjdCIsImFzc2lnbiIsIkpTT05Gcm9tUXVlcnkiLCJxdWVyeSIsIm9wdGlvbnMiLCJkaXN0aW5jdCIsIlN0cmluZyIsInBpcGVsaW5lIiwiZ2V0UGlwZWxpbmUiLCJ3aGVyZSIsIkpTT04iLCJwYXJzZSIsInJlc3QiLCJmaW5kIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsImluZm8iLCJjbGllbnRTREsiLCJ0aGVuIiwicmVzcG9uc2UiLCJyZXN1bHQiLCJyZXN1bHRzIiwiVXNlcnNSb3V0ZXIiLCJyZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzIiwiQXJyYXkiLCJpc0FycmF5Iiwia2V5cyIsIm1hcCIsImtleSIsInN0YWdlIiwibGVuZ3RoIiwiRXJyb3IiLCJqb2luIiwidHJhbnNmb3JtU3RhZ2UiLCJzdGFnZU5hbWUiLCJpbmRleE9mIiwiUGFyc2UiLCJJTlZBTElEX1FVRVJZIiwiaGFzT3duUHJvcGVydHkiLCJfaWQiLCJvYmplY3RJZCIsIm1vdW50Um91dGVzIiwicm91dGUiLCJwcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcyJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUFBOzs7O0FBQ0E7Ozs7QUFDQTs7SUFBWUEsVTs7QUFDWjs7OztBQUNBOzs7Ozs7OztBQUVBLE1BQU1DLFlBQVksQ0FBQyxPQUFELEVBQVUsVUFBVixFQUFzQixVQUF0QixDQUFsQjs7QUFFQSxNQUFNQyxnQkFBZ0IsQ0FDcEIsV0FEb0IsRUFFcEIsUUFGb0IsRUFHcEIsWUFIb0IsRUFJcEIsV0FKb0IsRUFLcEIsT0FMb0IsRUFNcEIsV0FOb0IsRUFPcEIsT0FQb0IsRUFRcEIs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QUFNLElBQUlFLGVBQU1MLEtBQVYsQ0FDSkssZUFBTUwsS0FBTixDQUFZTSxhQURSLEVBRUgsZ0NBQStCSCxTQUFVLEVBRnRDLENBQU47QUFJRDtBQUNELFFBQUlBLGNBQWMsT0FBbEIsRUFBMkI7QUFDekIsVUFBSUwsTUFBTUssU0FBTixFQUFpQkksY0FBakIsQ0FBZ0MsS0FBaEMsQ0FBSixFQUE0QztBQUMxQyxjQUFNLElBQUlGLGVBQU1MLEtBQVYsQ0FDSkssZUFBTUwsS0FBTixDQUFZTSxhQURSLEVBRUgsd0VBRkcsQ0FBTjtBQUlEO0FBQ0QsVUFBSSxDQUFDUixNQUFNSyxTQUFOLEVBQWlCSSxjQUFqQixDQUFnQyxVQUFoQyxDQUFMLEVBQWtEO0FBQ2hELGNBQU0sSUFBSUYsZUFBTUwsS0FBVixDQUNKSyxlQUFNTCxLQUFOLENBQVlNLGFBRFIsRUFFSCwwREFGRyxDQUFOO0FBSUQ7QUFDRFIsWUFBTUssU0FBTixFQUFpQkssR0FBakIsR0FBdUJWLE1BQU1LLFNBQU4sRUFBaUJNLFFBQXhDO0FBQ0EsYUFBT1gsTUFBTUssU0FBTixFQUFpQk0sUUFBeEI7QUFDRDtBQUNELFdBQU8sRUFBRSxDQUFFLElBQUdOLFNBQVUsRUFBZixHQUFtQkwsTUFBTUssU0FBTixDQUFyQixFQUFQO0FBQ0Q7O0FBRURPLGdCQUFjO0FBQ1osU0FBS0MsS0FBTCxDQUFXLEtBQVgsRUFBaUIsdUJBQWpCLEVBQTBDcEQsV0FBV3FELDZCQUFyRCxFQUFvRjlDLE9BQU87QUFBRSxhQUFPLEtBQUtELFVBQUwsQ0FBZ0JDLEdBQWhCLENBQVA7QUFBOEIsS0FBM0g7QUFDRDtBQTNGZ0Q7O1FBQXRDSCxlLEdBQUFBLGU7a0JBOEZFQSxlIiwiZmlsZSI6IkFnZ3JlZ2F0ZVJvdXRlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBDbGFzc2VzUm91dGVyIGZyb20gJy4vQ2xhc3Nlc1JvdXRlcic7XG5pbXBvcnQgcmVzdCBmcm9tICcuLi9yZXN0JztcbmltcG9ydCAqIGFzIG1pZGRsZXdhcmUgZnJvbSAnLi4vbWlkZGxld2FyZXMnO1xuaW1wb3J0IFBhcnNlICAgICAgICAgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgVXNlcnNSb3V0ZXIgICBmcm9tICcuL1VzZXJzUm91dGVyJztcblxuY29uc3QgQkFTRV9LRVlTID0gWyd3aGVyZScsICdkaXN0aW5jdCcsICdwaXBlbGluZSddO1xuXG5jb25zdCBQSVBFTElORV9LRVlTID0gW1xuICAnYWRkRmllbGRzJyxcbiAgJ2J1Y2tldCcsXG4gICdidWNrZXRBdXRvJyxcbiAgJ2NvbGxTdGF0cycsXG4gICdjb3VudCcsXG4gICdjdXJyZW50T3AnLFxuICAnZmFjZXQnLFxuICAnZ2VvTmVhcicsXG4gICdncmFwaExvb2t1cCcsXG4gICdncm91cCcsXG4gICdpbmRleFN0YXRzJyxcbiAgJ2xpbWl0JyxcbiAgJ2xpc3RMb2NhbFNlc3Npb25zJyxcbiAgJ2xpc3RTZXNzaW9ucycsXG4gICdsb29rdXAnLFxuICAnbWF0Y2gnLFxuICAnb3V0JyxcbiAgJ3Byb2plY3QnLFxuICAncmVkYWN0JyxcbiAgJ3JlcGxhY2VSb290JyxcbiAgJ3NhbXBsZScsXG4gICdza2lwJyxcbiAgJ3NvcnQnLFxuICAnc29ydEJ5Q291bnQnLFxuICAndW53aW5kJyxcbl07XG5cbmNvbnN0IEFMTE9XRURfS0VZUyA9IFsuLi5CQVNFX0tFWVMsIC4uLlBJUEVMSU5FX0tFWVNdO1xuXG5leHBvcnQgY2xhc3MgQWdncmVnYXRlUm91dGVyIGV4dGVuZHMgQ2xhc3Nlc1JvdXRlciB7XG5cbiAgaGFuZGxlRmluZChyZXEpIHtcbiAgICBjb25zdCBib2R5ID0gT2JqZWN0LmFzc2lnbihyZXEuYm9keSwgQ2xhc3Nlc1JvdXRlci5KU09ORnJvbVF1ZXJ5KHJlcS5xdWVyeSkpO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB7fTtcbiAgICBpZiAoYm9keS5kaXN0aW5jdCkge1xuICAgICAgb3B0aW9ucy5kaXN0aW5jdCA9IFN0cmluZyhib2R5LmRpc3RpbmN0KTtcbiAgICB9XG4gICAgb3B0aW9ucy5waXBlbGluZSA9IEFnZ3JlZ2F0ZVJvdXRlci5nZXRQaXBlbGluZShib2R5KTtcbiAgICBpZiAodHlwZW9mIGJvZHkud2hlcmUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBib2R5LndoZXJlID0gSlNPTi5wYXJzZShib2R5LndoZXJlKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3QuZmluZChyZXEuY29uZmlnLCByZXEuYXV0aCwgdGhpcy5jbGFzc05hbWUocmVxKSwgYm9keS53aGVyZSwgb3B0aW9ucywgcmVxLmluZm8uY2xpZW50U0RLKS50aGVuKChyZXNwb25zZSkgPT4ge1xuICAgICAgZm9yKGNvbnN0IHJlc3VsdCBvZiByZXNwb25zZS5yZXN1bHRzKSB7XG4gICAgICAgIGlmKHR5cGVvZiByZXN1bHQgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgVXNlcnNSb3V0ZXIucmVtb3ZlSGlkZGVuUHJvcGVydGllcyhyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4geyByZXNwb25zZSB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyogQnVpbGRzIGEgcGlwZWxpbmUgZnJvbSB0aGUgYm9keS4gT3JpZ2luYWxseSB0aGUgYm9keSBjb3VsZCBiZSBwYXNzZWQgYXMgYSBzaW5nbGUgb2JqZWN0LFxuICAgKiBhbmQgbm93IHdlIHN1cHBvcnQgbWFueSBvcHRpb25zXG4gICAqXG4gICAqIEFycmF5XG4gICAqXG4gICAqIGJvZHk6IFt7XG4gICAqICAgZ3JvdXA6IHsgb2JqZWN0SWQ6ICckbmFtZScgfSxcbiAgICogfV1cbiAgICpcbiAgICogT2JqZWN0XG4gICAqXG4gICAqIGJvZHk6IHtcbiAgICogICBncm91cDogeyBvYmplY3RJZDogJyRuYW1lJyB9LFxuICAgKiB9XG4gICAqXG4gICAqXG4gICAqIFBpcGVsaW5lIE9wZXJhdG9yIHdpdGggYW4gQXJyYXkgb3IgYW4gT2JqZWN0XG4gICAqXG4gICAqIGJvZHk6IHtcbiAgICogICBwaXBlbGluZToge1xuICAgKiAgICAgZ3JvdXA6IHsgb2JqZWN0SWQ6ICckbmFtZScgfSxcbiAgICogICB9XG4gICAqIH1cbiAgICpcbiAgICovXG4gIHN0YXRpYyBnZXRQaXBlbGluZShib2R5KSB7XG4gICAgbGV0IHBpcGVsaW5lID0gYm9keS5waXBlbGluZSB8fCBib2R5O1xuXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHBpcGVsaW5lKSkge1xuICAgICAgcGlwZWxpbmUgPSBPYmplY3Qua2V5cyhwaXBlbGluZSkubWFwKChrZXkpID0+IHsgcmV0dXJuIHsgW2tleV06IHBpcGVsaW5lW2tleV0gfSB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcGlwZWxpbmUubWFwKChzdGFnZSkgPT4ge1xuICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHN0YWdlKTtcbiAgICAgIGlmIChrZXlzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUGlwZWxpbmUgc3RhZ2VzIHNob3VsZCBvbmx5IGhhdmUgb25lIGtleSBmb3VuZCAke2tleXMuam9pbignLCAnKX1gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBBZ2dyZWdhdGVSb3V0ZXIudHJhbnNmb3JtU3RhZ2Uoa2V5c1swXSwgc3RhZ2UpO1xuICAgIH0pO1xuICB9XG5cbiAgc3RhdGljIHRyYW5zZm9ybVN0YWdlKHN0YWdlTmFtZSwgc3RhZ2UpIHtcbiAgICBpZiAoQUxMT1dFRF9LRVlTLmluZGV4T2Yoc3RhZ2VOYW1lKSA9PT0gLTEpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgYEludmFsaWQgcGFyYW1ldGVyIGZvciBxdWVyeTogJHtzdGFnZU5hbWV9YFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHN0YWdlTmFtZSA9PT0gJ2dyb3VwJykge1xuICAgICAgaWYgKHN0YWdlW3N0YWdlTmFtZV0uaGFzT3duUHJvcGVydHkoJ19pZCcpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgIGBJbnZhbGlkIHBhcmFtZXRlciBmb3IgcXVlcnk6IGdyb3VwLiBQbGVhc2UgdXNlIG9iamVjdElkIGluc3RlYWQgb2YgX2lkYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFzdGFnZVtzdGFnZU5hbWVdLmhhc093blByb3BlcnR5KCdvYmplY3RJZCcpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgIGBJbnZhbGlkIHBhcmFtZXRlciBmb3IgcXVlcnk6IGdyb3VwLiBvYmplY3RJZCBpcyByZXF1aXJlZGBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHN0YWdlW3N0YWdlTmFtZV0uX2lkID0gc3RhZ2Vbc3RhZ2VOYW1lXS5vYmplY3RJZDtcbiAgICAgIGRlbGV0ZSBzdGFnZVtzdGFnZU5hbWVdLm9iamVjdElkO1xuICAgIH1cbiAgICByZXR1cm4geyBbYCQke3N0YWdlTmFtZX1gXTogc3RhZ2Vbc3RhZ2VOYW1lXSB9O1xuICB9XG5cbiAgbW91bnRSb3V0ZXMoKSB7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywnL2FnZ3JlZ2F0ZS86Y2xhc3NOYW1lJywgbWlkZGxld2FyZS5wcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcywgcmVxID0+IHsgcmV0dXJuIHRoaXMuaGFuZGxlRmluZChyZXEpOyB9KTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBBZ2dyZWdhdGVSb3V0ZXI7XG4iXX0=