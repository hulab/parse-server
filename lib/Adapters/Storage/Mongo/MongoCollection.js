"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
exports.findGeoIndexField = findGeoIndexField;
const mongodb = require('mongodb');
const Collection = mongodb.Collection;

// Query operators that require a geospatial index and therefore trigger
// on-demand `2d` index creation. `$geoWithin` / `$geoIntersects` are intentionally
// excluded: they can run as a collection scan and never raise a "no index" error.
const GEO_INDEX_QUERY_OPERATORS = ['$nearSphere', '$near', '$geoNear'];

// Find the field in a Mongo query document that is constrained by a geo operator
// requiring a geospatial index. Returns the field name (e.g. 'location'), or
// undefined if none is found. Used as the reliable source of truth for on-demand
// geo index creation, since the MongoDB error message that used to carry the field
// name (`... field=<name> ...`) was dropped in MongoDB 8.3+.
//
// A geo-near expression must be top-level or inside `$and`: MongoDB rejects it inside
// `$or` / `$nor` ("geo $near must be top-level expr") and forbids more than one per
// query ("Too many geoNear expressions"). So there is at most one field to find, and
// `$and` is the only combinator we need to recurse into.
function findGeoIndexField(query) {
  if (!query || typeof query !== 'object') {
    return undefined;
  }
  for (const field of Object.keys(query)) {
    const value = query[field];
    // Recurse into `$and`, which holds an array of sub-queries.
    if (field === '$and' && Array.isArray(value)) {
      for (const subQuery of value) {
        const found = findGeoIndexField(subQuery);
        if (found) {
          return found;
        }
      }
      continue;
    }
    if (value && typeof value === 'object' && GEO_INDEX_QUERY_OPERATORS.some(op => Object.prototype.hasOwnProperty.call(value, op))) {
      return field;
    }
  }
  return undefined;
}
class MongoCollection {
  constructor(mongoCollection) {
    this._mongoCollection = mongoCollection;
  }

  // Does a find with "smart indexing".
  // Currently this just means, if it needs a geoindex and there is
  // none, then build the geoindex.
  // This could be improved a lot but it's not clear if that's a good
  // idea. Or even if this behavior is a good idea.
  find(query, {
    skip,
    limit,
    sort,
    keys,
    maxTimeMS,
    batchSize,
    readPreference,
    hint,
    caseInsensitive,
    explain,
    comment
  } = {}) {
    // Support for Full Text Search - $text
    if (keys && keys.$score) {
      delete keys.$score;
      keys.score = {
        $meta: 'textScore'
      };
    }
    const findOperation = this._rawFind(query, {
      skip,
      limit,
      sort,
      keys,
      maxTimeMS,
      batchSize,
      readPreference,
      hint,
      caseInsensitive,
      explain,
      comment
    });
    return findOperation.catch(error => {
      // Check for "no geoindex" error
      if (error.code != 17007 && !error.message.match(/unable to find index for .geoNear/)) {
        throw error;
      }
      // Figure out which field needs a geo index.
      // Older MongoDB embeds the field name in the error message (`... field=<name> ...`);
      // MongoDB 8.3+ shortened the message to `unable to find index for $geoNear query`
      // and no longer includes it, so fall back to reading the field from the query itself.
      const messageMatch = error.message.match(/field=([A-Za-z_0-9]+) /);
      const key = messageMatch && messageMatch[1] || findGeoIndexField(query);
      if (!key) {
        throw error;
      }
      var index = {};
      index[key] = '2d';
      return this._mongoCollection.createIndex(index)
      // Retry, but just once.
      .then(() => {
        const findOperation = this._rawFind(query, {
          skip,
          limit,
          sort,
          keys,
          maxTimeMS,
          batchSize,
          readPreference,
          hint,
          caseInsensitive,
          explain,
          comment
        });
        return findOperation;
      });
    });
  }

  /**
   * Collation to support case insensitive queries
   */
  static caseInsensitiveCollation() {
    return {
      locale: 'en_US',
      strength: 2
    };
  }
  _rawFind(query, {
    skip,
    limit,
    sort,
    keys,
    maxTimeMS,
    batchSize,
    readPreference,
    hint,
    caseInsensitive,
    explain,
    comment
  } = {}) {
    let findOperation = this._mongoCollection.find(query, {
      skip,
      limit,
      sort,
      readPreference,
      hint,
      comment,
      batchSize
    });
    if (keys) {
      findOperation = findOperation.project(keys);
    }
    if (caseInsensitive) {
      findOperation = findOperation.collation(MongoCollection.caseInsensitiveCollation());
    }
    if (maxTimeMS) {
      findOperation = findOperation.maxTimeMS(maxTimeMS);
    }
    return explain ? findOperation.explain(explain) : findOperation.toArray();
  }
  count(query, {
    skip,
    limit,
    sort,
    maxTimeMS,
    readPreference,
    hint,
    comment
  } = {}) {
    // If query is empty, then use estimatedDocumentCount instead.
    // This is due to countDocuments performing a scan,
    // which greatly increases execution time when being run on large collections.
    // See https://github.com/Automattic/mongoose/issues/6713 for more info regarding this problem.
    if (typeof query !== 'object' || !Object.keys(query).length) {
      const countOperation = this._mongoCollection.estimatedDocumentCount({
        maxTimeMS
      });
      return countOperation;
    }
    const countOperation = this._mongoCollection.countDocuments(query, {
      skip,
      limit,
      sort,
      maxTimeMS,
      readPreference,
      hint,
      comment
    });
    return countOperation;
  }
  distinct(field, query) {
    return this._mongoCollection.distinct(field, query);
  }
  aggregate(pipeline, {
    maxTimeMS,
    batchSize,
    readPreference,
    hint,
    explain,
    comment
  } = {}) {
    const aggregateOperation = this._mongoCollection.aggregate(pipeline, {
      maxTimeMS,
      batchSize,
      readPreference,
      hint,
      explain,
      comment
    }).toArray();
    return aggregateOperation;
  }
  insertOne(object, session) {
    return this._mongoCollection.insertOne(object, {
      session
    });
  }
  insertMany(object, session) {
    return this._mongoCollection.insertMany(object, {
      session
    });
  }

  // Atomically updates data in the database for a single (first) object that matched the query
  // If there is nothing that matches the query - does insert
  // Postgres Note: `INSERT ... ON CONFLICT UPDATE` that is available since 9.5.
  upsertOne(query, update, session) {
    return this._mongoCollection.updateOne(query, update, {
      upsert: true,
      session
    });
  }
  updateOne(query, update) {
    return this._mongoCollection.updateOne(query, update);
  }
  updateMany(query, update, session) {
    return this._mongoCollection.updateMany(query, update, {
      session
    });
  }
  deleteMany(query, session) {
    return this._mongoCollection.deleteMany(query, {
      session
    });
  }
  bulkWrite(operations, session) {
    return this._mongoCollection.bulkWrite(operations, {
      ordered: false,
      session
    });
  }
  _ensureSparseUniqueIndexInBackground(indexRequest) {
    return this._mongoCollection.createIndex(indexRequest, {
      unique: true,
      background: true,
      sparse: true
    });
  }
  drop() {
    return this._mongoCollection.drop();
  }
}
exports.default = MongoCollection;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJtb25nb2RiIiwicmVxdWlyZSIsIkNvbGxlY3Rpb24iLCJHRU9fSU5ERVhfUVVFUllfT1BFUkFUT1JTIiwiZmluZEdlb0luZGV4RmllbGQiLCJxdWVyeSIsInVuZGVmaW5lZCIsImZpZWxkIiwiT2JqZWN0Iiwia2V5cyIsInZhbHVlIiwiQXJyYXkiLCJpc0FycmF5Iiwic3ViUXVlcnkiLCJmb3VuZCIsInNvbWUiLCJvcCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIk1vbmdvQ29sbGVjdGlvbiIsImNvbnN0cnVjdG9yIiwibW9uZ29Db2xsZWN0aW9uIiwiX21vbmdvQ29sbGVjdGlvbiIsImZpbmQiLCJza2lwIiwibGltaXQiLCJzb3J0IiwibWF4VGltZU1TIiwiYmF0Y2hTaXplIiwicmVhZFByZWZlcmVuY2UiLCJoaW50IiwiY2FzZUluc2Vuc2l0aXZlIiwiZXhwbGFpbiIsImNvbW1lbnQiLCIkc2NvcmUiLCJzY29yZSIsIiRtZXRhIiwiZmluZE9wZXJhdGlvbiIsIl9yYXdGaW5kIiwiY2F0Y2giLCJlcnJvciIsImNvZGUiLCJtZXNzYWdlIiwibWF0Y2giLCJtZXNzYWdlTWF0Y2giLCJrZXkiLCJpbmRleCIsImNyZWF0ZUluZGV4IiwidGhlbiIsImNhc2VJbnNlbnNpdGl2ZUNvbGxhdGlvbiIsImxvY2FsZSIsInN0cmVuZ3RoIiwicHJvamVjdCIsImNvbGxhdGlvbiIsInRvQXJyYXkiLCJjb3VudCIsImxlbmd0aCIsImNvdW50T3BlcmF0aW9uIiwiZXN0aW1hdGVkRG9jdW1lbnRDb3VudCIsImNvdW50RG9jdW1lbnRzIiwiZGlzdGluY3QiLCJhZ2dyZWdhdGUiLCJwaXBlbGluZSIsImFnZ3JlZ2F0ZU9wZXJhdGlvbiIsImluc2VydE9uZSIsIm9iamVjdCIsInNlc3Npb24iLCJpbnNlcnRNYW55IiwidXBzZXJ0T25lIiwidXBkYXRlIiwidXBkYXRlT25lIiwidXBzZXJ0IiwidXBkYXRlTWFueSIsImRlbGV0ZU1hbnkiLCJidWxrV3JpdGUiLCJvcGVyYXRpb25zIiwib3JkZXJlZCIsIl9lbnN1cmVTcGFyc2VVbmlxdWVJbmRleEluQmFja2dyb3VuZCIsImluZGV4UmVxdWVzdCIsInVuaXF1ZSIsImJhY2tncm91bmQiLCJzcGFyc2UiLCJkcm9wIiwiZXhwb3J0cyIsImRlZmF1bHQiXSwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvQWRhcHRlcnMvU3RvcmFnZS9Nb25nby9Nb25nb0NvbGxlY3Rpb24uanMiXSwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgbW9uZ29kYiA9IHJlcXVpcmUoJ21vbmdvZGInKTtcbmNvbnN0IENvbGxlY3Rpb24gPSBtb25nb2RiLkNvbGxlY3Rpb247XG5cbi8vIFF1ZXJ5IG9wZXJhdG9ycyB0aGF0IHJlcXVpcmUgYSBnZW9zcGF0aWFsIGluZGV4IGFuZCB0aGVyZWZvcmUgdHJpZ2dlclxuLy8gb24tZGVtYW5kIGAyZGAgaW5kZXggY3JlYXRpb24uIGAkZ2VvV2l0aGluYCAvIGAkZ2VvSW50ZXJzZWN0c2AgYXJlIGludGVudGlvbmFsbHlcbi8vIGV4Y2x1ZGVkOiB0aGV5IGNhbiBydW4gYXMgYSBjb2xsZWN0aW9uIHNjYW4gYW5kIG5ldmVyIHJhaXNlIGEgXCJubyBpbmRleFwiIGVycm9yLlxuY29uc3QgR0VPX0lOREVYX1FVRVJZX09QRVJBVE9SUyA9IFsnJG5lYXJTcGhlcmUnLCAnJG5lYXInLCAnJGdlb05lYXInXTtcblxuLy8gRmluZCB0aGUgZmllbGQgaW4gYSBNb25nbyBxdWVyeSBkb2N1bWVudCB0aGF0IGlzIGNvbnN0cmFpbmVkIGJ5IGEgZ2VvIG9wZXJhdG9yXG4vLyByZXF1aXJpbmcgYSBnZW9zcGF0aWFsIGluZGV4LiBSZXR1cm5zIHRoZSBmaWVsZCBuYW1lIChlLmcuICdsb2NhdGlvbicpLCBvclxuLy8gdW5kZWZpbmVkIGlmIG5vbmUgaXMgZm91bmQuIFVzZWQgYXMgdGhlIHJlbGlhYmxlIHNvdXJjZSBvZiB0cnV0aCBmb3Igb24tZGVtYW5kXG4vLyBnZW8gaW5kZXggY3JlYXRpb24sIHNpbmNlIHRoZSBNb25nb0RCIGVycm9yIG1lc3NhZ2UgdGhhdCB1c2VkIHRvIGNhcnJ5IHRoZSBmaWVsZFxuLy8gbmFtZSAoYC4uLiBmaWVsZD08bmFtZT4gLi4uYCkgd2FzIGRyb3BwZWQgaW4gTW9uZ29EQiA4LjMrLlxuLy9cbi8vIEEgZ2VvLW5lYXIgZXhwcmVzc2lvbiBtdXN0IGJlIHRvcC1sZXZlbCBvciBpbnNpZGUgYCRhbmRgOiBNb25nb0RCIHJlamVjdHMgaXQgaW5zaWRlXG4vLyBgJG9yYCAvIGAkbm9yYCAoXCJnZW8gJG5lYXIgbXVzdCBiZSB0b3AtbGV2ZWwgZXhwclwiKSBhbmQgZm9yYmlkcyBtb3JlIHRoYW4gb25lIHBlclxuLy8gcXVlcnkgKFwiVG9vIG1hbnkgZ2VvTmVhciBleHByZXNzaW9uc1wiKS4gU28gdGhlcmUgaXMgYXQgbW9zdCBvbmUgZmllbGQgdG8gZmluZCwgYW5kXG4vLyBgJGFuZGAgaXMgdGhlIG9ubHkgY29tYmluYXRvciB3ZSBuZWVkIHRvIHJlY3Vyc2UgaW50by5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kR2VvSW5kZXhGaWVsZChxdWVyeSkge1xuICBpZiAoIXF1ZXJ5IHx8IHR5cGVvZiBxdWVyeSAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGZvciAoY29uc3QgZmllbGQgb2YgT2JqZWN0LmtleXMocXVlcnkpKSB7XG4gICAgY29uc3QgdmFsdWUgPSBxdWVyeVtmaWVsZF07XG4gICAgLy8gUmVjdXJzZSBpbnRvIGAkYW5kYCwgd2hpY2ggaG9sZHMgYW4gYXJyYXkgb2Ygc3ViLXF1ZXJpZXMuXG4gICAgaWYgKGZpZWxkID09PSAnJGFuZCcgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIGZvciAoY29uc3Qgc3ViUXVlcnkgb2YgdmFsdWUpIHtcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kR2VvSW5kZXhGaWVsZChzdWJRdWVyeSk7XG4gICAgICAgIGlmIChmb3VuZCkge1xuICAgICAgICAgIHJldHVybiBmb3VuZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIHZhbHVlICYmXG4gICAgICB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmXG4gICAgICBHRU9fSU5ERVhfUVVFUllfT1BFUkFUT1JTLnNvbWUob3AgPT4gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHZhbHVlLCBvcCkpXG4gICAgKSB7XG4gICAgICByZXR1cm4gZmllbGQ7XG4gICAgfVxuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIE1vbmdvQ29sbGVjdGlvbiB7XG4gIF9tb25nb0NvbGxlY3Rpb246IENvbGxlY3Rpb247XG5cbiAgY29uc3RydWN0b3IobW9uZ29Db2xsZWN0aW9uOiBDb2xsZWN0aW9uKSB7XG4gICAgdGhpcy5fbW9uZ29Db2xsZWN0aW9uID0gbW9uZ29Db2xsZWN0aW9uO1xuICB9XG5cbiAgLy8gRG9lcyBhIGZpbmQgd2l0aCBcInNtYXJ0IGluZGV4aW5nXCIuXG4gIC8vIEN1cnJlbnRseSB0aGlzIGp1c3QgbWVhbnMsIGlmIGl0IG5lZWRzIGEgZ2VvaW5kZXggYW5kIHRoZXJlIGlzXG4gIC8vIG5vbmUsIHRoZW4gYnVpbGQgdGhlIGdlb2luZGV4LlxuICAvLyBUaGlzIGNvdWxkIGJlIGltcHJvdmVkIGEgbG90IGJ1dCBpdCdzIG5vdCBjbGVhciBpZiB0aGF0J3MgYSBnb29kXG4gIC8vIGlkZWEuIE9yIGV2ZW4gaWYgdGhpcyBiZWhhdmlvciBpcyBhIGdvb2QgaWRlYS5cbiAgZmluZChcbiAgICBxdWVyeSxcbiAgICB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAga2V5cyxcbiAgICAgIG1heFRpbWVNUyxcbiAgICAgIGJhdGNoU2l6ZSxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgaGludCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgICBjb21tZW50LFxuICAgIH0gPSB7fVxuICApIHtcbiAgICAvLyBTdXBwb3J0IGZvciBGdWxsIFRleHQgU2VhcmNoIC0gJHRleHRcbiAgICBpZiAoa2V5cyAmJiBrZXlzLiRzY29yZSkge1xuICAgICAgZGVsZXRlIGtleXMuJHNjb3JlO1xuICAgICAga2V5cy5zY29yZSA9IHsgJG1ldGE6ICd0ZXh0U2NvcmUnIH07XG4gICAgfVxuICAgIGNvbnN0IGZpbmRPcGVyYXRpb24gPSB0aGlzLl9yYXdGaW5kKHF1ZXJ5LCB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAga2V5cyxcbiAgICAgIG1heFRpbWVNUyxcbiAgICAgIGJhdGNoU2l6ZSxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgaGludCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgICBjb21tZW50LFxuICAgIH0pO1xuICAgIHJldHVybiBmaW5kT3BlcmF0aW9uLmNhdGNoKGVycm9yID0+IHtcbiAgICAgIC8vIENoZWNrIGZvciBcIm5vIGdlb2luZGV4XCIgZXJyb3JcbiAgICAgIGlmIChlcnJvci5jb2RlICE9IDE3MDA3ICYmICFlcnJvci5tZXNzYWdlLm1hdGNoKC91bmFibGUgdG8gZmluZCBpbmRleCBmb3IgLmdlb05lYXIvKSkge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIC8vIEZpZ3VyZSBvdXQgd2hpY2ggZmllbGQgbmVlZHMgYSBnZW8gaW5kZXguXG4gICAgICAvLyBPbGRlciBNb25nb0RCIGVtYmVkcyB0aGUgZmllbGQgbmFtZSBpbiB0aGUgZXJyb3IgbWVzc2FnZSAoYC4uLiBmaWVsZD08bmFtZT4gLi4uYCk7XG4gICAgICAvLyBNb25nb0RCIDguMysgc2hvcnRlbmVkIHRoZSBtZXNzYWdlIHRvIGB1bmFibGUgdG8gZmluZCBpbmRleCBmb3IgJGdlb05lYXIgcXVlcnlgXG4gICAgICAvLyBhbmQgbm8gbG9uZ2VyIGluY2x1ZGVzIGl0LCBzbyBmYWxsIGJhY2sgdG8gcmVhZGluZyB0aGUgZmllbGQgZnJvbSB0aGUgcXVlcnkgaXRzZWxmLlxuICAgICAgY29uc3QgbWVzc2FnZU1hdGNoID0gZXJyb3IubWVzc2FnZS5tYXRjaCgvZmllbGQ9KFtBLVphLXpfMC05XSspIC8pO1xuICAgICAgY29uc3Qga2V5ID0gKG1lc3NhZ2VNYXRjaCAmJiBtZXNzYWdlTWF0Y2hbMV0pIHx8IGZpbmRHZW9JbmRleEZpZWxkKHF1ZXJ5KTtcbiAgICAgIGlmICgha2V5KSB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuXG4gICAgICB2YXIgaW5kZXggPSB7fTtcbiAgICAgIGluZGV4W2tleV0gPSAnMmQnO1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgdGhpcy5fbW9uZ29Db2xsZWN0aW9uXG4gICAgICAgICAgLmNyZWF0ZUluZGV4KGluZGV4KVxuICAgICAgICAgIC8vIFJldHJ5LCBidXQganVzdCBvbmNlLlxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGZpbmRPcGVyYXRpb24gPSB0aGlzLl9yYXdGaW5kKHF1ZXJ5LCB7XG4gICAgICAgICAgICAgIHNraXAsXG4gICAgICAgICAgICAgIGxpbWl0LFxuICAgICAgICAgICAgICBzb3J0LFxuICAgICAgICAgICAgICBrZXlzLFxuICAgICAgICAgICAgICBtYXhUaW1lTVMsXG4gICAgICAgICAgICAgIGJhdGNoU2l6ZSxcbiAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICAgICAgY29tbWVudCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGZpbmRPcGVyYXRpb247XG4gICAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQ29sbGF0aW9uIHRvIHN1cHBvcnQgY2FzZSBpbnNlbnNpdGl2ZSBxdWVyaWVzXG4gICAqL1xuICBzdGF0aWMgY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uKCkge1xuICAgIHJldHVybiB7IGxvY2FsZTogJ2VuX1VTJywgc3RyZW5ndGg6IDIgfTtcbiAgfVxuXG4gIF9yYXdGaW5kKFxuICAgIHF1ZXJ5LFxuICAgIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIHNvcnQsXG4gICAgICBrZXlzLFxuICAgICAgbWF4VGltZU1TLFxuICAgICAgYmF0Y2hTaXplLFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgZXhwbGFpbixcbiAgICAgIGNvbW1lbnQsXG4gICAgfSA9IHt9XG4gICkge1xuICAgIGxldCBmaW5kT3BlcmF0aW9uID0gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmZpbmQocXVlcnksIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIHNvcnQsXG4gICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgIGhpbnQsXG4gICAgICBjb21tZW50LFxuICAgICAgYmF0Y2hTaXplLFxuICAgIH0pO1xuXG4gICAgaWYgKGtleXMpIHtcbiAgICAgIGZpbmRPcGVyYXRpb24gPSBmaW5kT3BlcmF0aW9uLnByb2plY3Qoa2V5cyk7XG4gICAgfVxuXG4gICAgaWYgKGNhc2VJbnNlbnNpdGl2ZSkge1xuICAgICAgZmluZE9wZXJhdGlvbiA9IGZpbmRPcGVyYXRpb24uY29sbGF0aW9uKE1vbmdvQ29sbGVjdGlvbi5jYXNlSW5zZW5zaXRpdmVDb2xsYXRpb24oKSk7XG4gICAgfVxuXG4gICAgaWYgKG1heFRpbWVNUykge1xuICAgICAgZmluZE9wZXJhdGlvbiA9IGZpbmRPcGVyYXRpb24ubWF4VGltZU1TKG1heFRpbWVNUyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGV4cGxhaW4gPyBmaW5kT3BlcmF0aW9uLmV4cGxhaW4oZXhwbGFpbikgOiBmaW5kT3BlcmF0aW9uLnRvQXJyYXkoKTtcbiAgfVxuXG4gIGNvdW50KHF1ZXJ5LCB7IHNraXAsIGxpbWl0LCBzb3J0LCBtYXhUaW1lTVMsIHJlYWRQcmVmZXJlbmNlLCBoaW50LCBjb21tZW50IH0gPSB7fSkge1xuICAgIC8vIElmIHF1ZXJ5IGlzIGVtcHR5LCB0aGVuIHVzZSBlc3RpbWF0ZWREb2N1bWVudENvdW50IGluc3RlYWQuXG4gICAgLy8gVGhpcyBpcyBkdWUgdG8gY291bnREb2N1bWVudHMgcGVyZm9ybWluZyBhIHNjYW4sXG4gICAgLy8gd2hpY2ggZ3JlYXRseSBpbmNyZWFzZXMgZXhlY3V0aW9uIHRpbWUgd2hlbiBiZWluZyBydW4gb24gbGFyZ2UgY29sbGVjdGlvbnMuXG4gICAgLy8gU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9BdXRvbWF0dGljL21vbmdvb3NlL2lzc3Vlcy82NzEzIGZvciBtb3JlIGluZm8gcmVnYXJkaW5nIHRoaXMgcHJvYmxlbS5cbiAgICBpZiAodHlwZW9mIHF1ZXJ5ICE9PSAnb2JqZWN0JyB8fCAhT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCkge1xuICAgICAgY29uc3QgY291bnRPcGVyYXRpb24gPSB0aGlzLl9tb25nb0NvbGxlY3Rpb24uZXN0aW1hdGVkRG9jdW1lbnRDb3VudCh7XG4gICAgICAgIG1heFRpbWVNUyxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGNvdW50T3BlcmF0aW9uO1xuICAgIH1cblxuICAgIGNvbnN0IGNvdW50T3BlcmF0aW9uID0gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmNvdW50RG9jdW1lbnRzKHF1ZXJ5LCB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAgbWF4VGltZU1TLFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY29tbWVudCxcbiAgICB9KTtcbiAgICByZXR1cm4gY291bnRPcGVyYXRpb247XG4gIH1cblxuICBkaXN0aW5jdChmaWVsZCwgcXVlcnkpIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmRpc3RpbmN0KGZpZWxkLCBxdWVyeSk7XG4gIH1cblxuICBhZ2dyZWdhdGUocGlwZWxpbmUsIHsgbWF4VGltZU1TLCBiYXRjaFNpemUsIHJlYWRQcmVmZXJlbmNlLCBoaW50LCBleHBsYWluLCBjb21tZW50IH0gPSB7fSkge1xuICAgIGNvbnN0IGFnZ3JlZ2F0ZU9wZXJhdGlvbiA9IHRoaXMuX21vbmdvQ29sbGVjdGlvblxuICAgICAgLmFnZ3JlZ2F0ZShwaXBlbGluZSwgeyBtYXhUaW1lTVMsIGJhdGNoU2l6ZSwgcmVhZFByZWZlcmVuY2UsIGhpbnQsIGV4cGxhaW4sIGNvbW1lbnQgfSlcbiAgICAgIC50b0FycmF5KCk7XG4gICAgcmV0dXJuIGFnZ3JlZ2F0ZU9wZXJhdGlvbjtcbiAgfVxuXG4gIGluc2VydE9uZShvYmplY3QsIHNlc3Npb24pIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmluc2VydE9uZShvYmplY3QsIHsgc2Vzc2lvbiB9KTtcbiAgfVxuXG4gIGluc2VydE1hbnkob2JqZWN0LCBzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5pbnNlcnRNYW55KG9iamVjdCwgeyBzZXNzaW9uIH0pO1xuICB9XG5cbiAgLy8gQXRvbWljYWxseSB1cGRhdGVzIGRhdGEgaW4gdGhlIGRhdGFiYXNlIGZvciBhIHNpbmdsZSAoZmlyc3QpIG9iamVjdCB0aGF0IG1hdGNoZWQgdGhlIHF1ZXJ5XG4gIC8vIElmIHRoZXJlIGlzIG5vdGhpbmcgdGhhdCBtYXRjaGVzIHRoZSBxdWVyeSAtIGRvZXMgaW5zZXJ0XG4gIC8vIFBvc3RncmVzIE5vdGU6IGBJTlNFUlQgLi4uIE9OIENPTkZMSUNUIFVQREFURWAgdGhhdCBpcyBhdmFpbGFibGUgc2luY2UgOS41LlxuICB1cHNlcnRPbmUocXVlcnksIHVwZGF0ZSwgc2Vzc2lvbikge1xuICAgIHJldHVybiB0aGlzLl9tb25nb0NvbGxlY3Rpb24udXBkYXRlT25lKHF1ZXJ5LCB1cGRhdGUsIHtcbiAgICAgIHVwc2VydDogdHJ1ZSxcbiAgICAgIHNlc3Npb24sXG4gICAgfSk7XG4gIH1cblxuICB1cGRhdGVPbmUocXVlcnksIHVwZGF0ZSkge1xuICAgIHJldHVybiB0aGlzLl9tb25nb0NvbGxlY3Rpb24udXBkYXRlT25lKHF1ZXJ5LCB1cGRhdGUpO1xuICB9XG5cbiAgdXBkYXRlTWFueShxdWVyeSwgdXBkYXRlLCBzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi51cGRhdGVNYW55KHF1ZXJ5LCB1cGRhdGUsIHsgc2Vzc2lvbiB9KTtcbiAgfVxuXG4gIGRlbGV0ZU1hbnkocXVlcnksIHNlc3Npb24pIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmRlbGV0ZU1hbnkocXVlcnksIHsgc2Vzc2lvbiB9KTtcbiAgfVxuXG4gIGJ1bGtXcml0ZShvcGVyYXRpb25zLCBzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5idWxrV3JpdGUob3BlcmF0aW9ucywgeyBvcmRlcmVkOiBmYWxzZSwgc2Vzc2lvbiB9KTtcbiAgfVxuXG4gIF9lbnN1cmVTcGFyc2VVbmlxdWVJbmRleEluQmFja2dyb3VuZChpbmRleFJlcXVlc3QpIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4KGluZGV4UmVxdWVzdCwge1xuICAgICAgdW5pcXVlOiB0cnVlLFxuICAgICAgYmFja2dyb3VuZDogdHJ1ZSxcbiAgICAgIHNwYXJzZTogdHJ1ZSxcbiAgICB9KTtcbiAgfVxuXG4gIGRyb3AoKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5kcm9wKCk7XG4gIH1cblxufVxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUEsTUFBTUEsT0FBTyxHQUFHQyxPQUFPLENBQUMsU0FBUyxDQUFDO0FBQ2xDLE1BQU1DLFVBQVUsR0FBR0YsT0FB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