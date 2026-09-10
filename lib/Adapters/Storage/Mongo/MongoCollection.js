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
    return this._rawFind(query, {
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
    }).catch(error => {
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
      .then(() => this._rawFind(query, {
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
      }));
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
      return this._mongoCollection.estimatedDocumentCount({
        maxTimeMS
      });
    }
    return this._mongoCollection.countDocuments(query, {
      skip,
      limit,
      sort,
      maxTimeMS,
      readPreference,
      hint,
      comment
    });
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
    return this._mongoCollection.aggregate(pipeline, {
      maxTimeMS,
      batchSize,
      readPreference,
      hint,
      explain,
      comment
    }).toArray();
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJtb25nb2RiIiwicmVxdWlyZSIsIkNvbGxlY3Rpb24iLCJHRU9fSU5ERVhfUVVFUllfT1BFUkFUT1JTIiwiZmluZEdlb0luZGV4RmllbGQiLCJxdWVyeSIsInVuZGVmaW5lZCIsImZpZWxkIiwiT2JqZWN0Iiwia2V5cyIsInZhbHVlIiwiQXJyYXkiLCJpc0FycmF5Iiwic3ViUXVlcnkiLCJmb3VuZCIsInNvbWUiLCJvcCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIk1vbmdvQ29sbGVjdGlvbiIsImNvbnN0cnVjdG9yIiwibW9uZ29Db2xsZWN0aW9uIiwiX21vbmdvQ29sbGVjdGlvbiIsImZpbmQiLCJza2lwIiwibGltaXQiLCJzb3J0IiwibWF4VGltZU1TIiwiYmF0Y2hTaXplIiwicmVhZFByZWZlcmVuY2UiLCJoaW50IiwiY2FzZUluc2Vuc2l0aXZlIiwiZXhwbGFpbiIsImNvbW1lbnQiLCIkc2NvcmUiLCJzY29yZSIsIiRtZXRhIiwiX3Jhd0ZpbmQiLCJjYXRjaCIsImVycm9yIiwiY29kZSIsIm1lc3NhZ2UiLCJtYXRjaCIsIm1lc3NhZ2VNYXRjaCIsImtleSIsImluZGV4IiwiY3JlYXRlSW5kZXgiLCJ0aGVuIiwiY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uIiwibG9jYWxlIiwic3RyZW5ndGgiLCJmaW5kT3BlcmF0aW9uIiwicHJvamVjdCIsImNvbGxhdGlvbiIsInRvQXJyYXkiLCJjb3VudCIsImxlbmd0aCIsImVzdGltYXRlZERvY3VtZW50Q291bnQiLCJjb3VudERvY3VtZW50cyIsImRpc3RpbmN0IiwiYWdncmVnYXRlIiwicGlwZWxpbmUiLCJpbnNlcnRPbmUiLCJvYmplY3QiLCJzZXNzaW9uIiwiaW5zZXJ0TWFueSIsInVwc2VydE9uZSIsInVwZGF0ZSIsInVwZGF0ZU9uZSIsInVwc2VydCIsInVwZGF0ZU1hbnkiLCJkZWxldGVNYW55IiwiX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kIiwiaW5kZXhSZXF1ZXN0IiwidW5pcXVlIiwiYmFja2dyb3VuZCIsInNwYXJzZSIsImRyb3AiLCJleHBvcnRzIiwiZGVmYXVsdCJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvQ29sbGVjdGlvbi5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBtb25nb2RiID0gcmVxdWlyZSgnbW9uZ29kYicpO1xuY29uc3QgQ29sbGVjdGlvbiA9IG1vbmdvZGIuQ29sbGVjdGlvbjtcblxuLy8gUXVlcnkgb3BlcmF0b3JzIHRoYXQgcmVxdWlyZSBhIGdlb3NwYXRpYWwgaW5kZXggYW5kIHRoZXJlZm9yZSB0cmlnZ2VyXG4vLyBvbi1kZW1hbmQgYDJkYCBpbmRleCBjcmVhdGlvbi4gYCRnZW9XaXRoaW5gIC8gYCRnZW9JbnRlcnNlY3RzYCBhcmUgaW50ZW50aW9uYWxseVxuLy8gZXhjbHVkZWQ6IHRoZXkgY2FuIHJ1biBhcyBhIGNvbGxlY3Rpb24gc2NhbiBhbmQgbmV2ZXIgcmFpc2UgYSBcIm5vIGluZGV4XCIgZXJyb3IuXG5jb25zdCBHRU9fSU5ERVhfUVVFUllfT1BFUkFUT1JTID0gWyckbmVhclNwaGVyZScsICckbmVhcicsICckZ2VvTmVhciddO1xuXG4vLyBGaW5kIHRoZSBmaWVsZCBpbiBhIE1vbmdvIHF1ZXJ5IGRvY3VtZW50IHRoYXQgaXMgY29uc3RyYWluZWQgYnkgYSBnZW8gb3BlcmF0b3Jcbi8vIHJlcXVpcmluZyBhIGdlb3NwYXRpYWwgaW5kZXguIFJldHVybnMgdGhlIGZpZWxkIG5hbWUgKGUuZy4gJ2xvY2F0aW9uJyksIG9yXG4vLyB1bmRlZmluZWQgaWYgbm9uZSBpcyBmb3VuZC4gVXNlZCBhcyB0aGUgcmVsaWFibGUgc291cmNlIG9mIHRydXRoIGZvciBvbi1kZW1hbmRcbi8vIGdlbyBpbmRleCBjcmVhdGlvbiwgc2luY2UgdGhlIE1vbmdvREIgZXJyb3IgbWVzc2FnZSB0aGF0IHVzZWQgdG8gY2FycnkgdGhlIGZpZWxkXG4vLyBuYW1lIChgLi4uIGZpZWxkPTxuYW1lPiAuLi5gKSB3YXMgZHJvcHBlZCBpbiBNb25nb0RCIDguMysuXG4vL1xuLy8gQSBnZW8tbmVhciBleHByZXNzaW9uIG11c3QgYmUgdG9wLWxldmVsIG9yIGluc2lkZSBgJGFuZGA6IE1vbmdvREIgcmVqZWN0cyBpdCBpbnNpZGVcbi8vIGAkb3JgIC8gYCRub3JgIChcImdlbyAkbmVhciBtdXN0IGJlIHRvcC1sZXZlbCBleHByXCIpIGFuZCBmb3JiaWRzIG1vcmUgdGhhbiBvbmUgcGVyXG4vLyBxdWVyeSAoXCJUb28gbWFueSBnZW9OZWFyIGV4cHJlc3Npb25zXCIpLiBTbyB0aGVyZSBpcyBhdCBtb3N0IG9uZSBmaWVsZCB0byBmaW5kLCBhbmRcbi8vIGAkYW5kYCBpcyB0aGUgb25seSBjb21iaW5hdG9yIHdlIG5lZWQgdG8gcmVjdXJzZSBpbnRvLlxuZXhwb3J0IGZ1bmN0aW9uIGZpbmRHZW9JbmRleEZpZWxkKHF1ZXJ5KSB7XG4gIGlmICghcXVlcnkgfHwgdHlwZW9mIHF1ZXJ5ICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgZm9yIChjb25zdCBmaWVsZCBvZiBPYmplY3Qua2V5cyhxdWVyeSkpIHtcbiAgICBjb25zdCB2YWx1ZSA9IHF1ZXJ5W2ZpZWxkXTtcbiAgICAvLyBSZWN1cnNlIGludG8gYCRhbmRgLCB3aGljaCBob2xkcyBhbiBhcnJheSBvZiBzdWItcXVlcmllcy5cbiAgICBpZiAoZmllbGQgPT09ICckYW5kJyAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgZm9yIChjb25zdCBzdWJRdWVyeSBvZiB2YWx1ZSkge1xuICAgICAgICBjb25zdCBmb3VuZCA9IGZpbmRHZW9JbmRleEZpZWxkKHN1YlF1ZXJ5KTtcbiAgICAgICAgaWYgKGZvdW5kKSB7XG4gICAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgdmFsdWUgJiZcbiAgICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgIEdFT19JTkRFWF9RVUVSWV9PUEVSQVRPUlMuc29tZShvcCA9PiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodmFsdWUsIG9wKSlcbiAgICApIHtcbiAgICAgIHJldHVybiBmaWVsZDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgTW9uZ29Db2xsZWN0aW9uIHtcbiAgX21vbmdvQ29sbGVjdGlvbjogQ29sbGVjdGlvbjtcblxuICBjb25zdHJ1Y3Rvcihtb25nb0NvbGxlY3Rpb246IENvbGxlY3Rpb24pIHtcbiAgICB0aGlzLl9tb25nb0NvbGxlY3Rpb24gPSBtb25nb0NvbGxlY3Rpb247XG4gIH1cblxuICAvLyBEb2VzIGEgZmluZCB3aXRoIFwic21hcnQgaW5kZXhpbmdcIi5cbiAgLy8gQ3VycmVudGx5IHRoaXMganVzdCBtZWFucywgaWYgaXQgbmVlZHMgYSBnZW9pbmRleCBhbmQgdGhlcmUgaXNcbiAgLy8gbm9uZSwgdGhlbiBidWlsZCB0aGUgZ2VvaW5kZXguXG4gIC8vIFRoaXMgY291bGQgYmUgaW1wcm92ZWQgYSBsb3QgYnV0IGl0J3Mgbm90IGNsZWFyIGlmIHRoYXQncyBhIGdvb2RcbiAgLy8gaWRlYS4gT3IgZXZlbiBpZiB0aGlzIGJlaGF2aW9yIGlzIGEgZ29vZCBpZGVhLlxuICBmaW5kKFxuICAgIHF1ZXJ5LFxuICAgIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIHNvcnQsXG4gICAgICBrZXlzLFxuICAgICAgbWF4VGltZU1TLFxuICAgICAgYmF0Y2hTaXplLFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgZXhwbGFpbixcbiAgICAgIGNvbW1lbnQsXG4gICAgfSA9IHt9XG4gICkge1xuICAgIC8vIFN1cHBvcnQgZm9yIEZ1bGwgVGV4dCBTZWFyY2ggLSAkdGV4dFxuICAgIGlmIChrZXlzICYmIGtleXMuJHNjb3JlKSB7XG4gICAgICBkZWxldGUga2V5cy4kc2NvcmU7XG4gICAgICBrZXlzLnNjb3JlID0geyAkbWV0YTogJ3RleHRTY29yZScgfTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX3Jhd0ZpbmQocXVlcnksIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIHNvcnQsXG4gICAgICBrZXlzLFxuICAgICAgbWF4VGltZU1TLFxuICAgICAgYmF0Y2hTaXplLFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgZXhwbGFpbixcbiAgICAgIGNvbW1lbnQsXG4gICAgfSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgLy8gQ2hlY2sgZm9yIFwibm8gZ2VvaW5kZXhcIiBlcnJvclxuICAgICAgaWYgKGVycm9yLmNvZGUgIT0gMTcwMDcgJiYgIWVycm9yLm1lc3NhZ2UubWF0Y2goL3VuYWJsZSB0byBmaW5kIGluZGV4IGZvciAuZ2VvTmVhci8pKSB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgICAgLy8gRmlndXJlIG91dCB3aGljaCBmaWVsZCBuZWVkcyBhIGdlbyBpbmRleC5cbiAgICAgIC8vIE9sZGVyIE1vbmdvREIgZW1iZWRzIHRoZSBmaWVsZCBuYW1lIGluIHRoZSBlcnJvciBtZXNzYWdlIChgLi4uIGZpZWxkPTxuYW1lPiAuLi5gKTtcbiAgICAgIC8vIE1vbmdvREIgOC4zKyBzaG9ydGVuZWQgdGhlIG1lc3NhZ2UgdG8gYHVuYWJsZSB0byBmaW5kIGluZGV4IGZvciAkZ2VvTmVhciBxdWVyeWBcbiAgICAgIC8vIGFuZCBubyBsb25nZXIgaW5jbHVkZXMgaXQsIHNvIGZhbGwgYmFjayB0byByZWFkaW5nIHRoZSBmaWVsZCBmcm9tIHRoZSBxdWVyeSBpdHNlbGYuXG4gICAgICBjb25zdCBtZXNzYWdlTWF0Y2ggPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9maWVsZD0oW0EtWmEtel8wLTldKykgLyk7XG4gICAgICBjb25zdCBrZXkgPSAobWVzc2FnZU1hdGNoICYmIG1lc3NhZ2VNYXRjaFsxXSkgfHwgZmluZEdlb0luZGV4RmllbGQocXVlcnkpO1xuICAgICAgaWYgKCFrZXkpIHtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG5cbiAgICAgIHZhciBpbmRleCA9IHt9O1xuICAgICAgaW5kZXhba2V5XSA9ICcyZCc7XG4gICAgICByZXR1cm4gKFxuICAgICAgICB0aGlzLl9tb25nb0NvbGxlY3Rpb25cbiAgICAgICAgICAuY3JlYXRlSW5kZXgoaW5kZXgpXG4gICAgICAgICAgLy8gUmV0cnksIGJ1dCBqdXN0IG9uY2UuXG4gICAgICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgICAgIHRoaXMuX3Jhd0ZpbmQocXVlcnksIHtcbiAgICAgICAgICAgICAgc2tpcCxcbiAgICAgICAgICAgICAgbGltaXQsXG4gICAgICAgICAgICAgIHNvcnQsXG4gICAgICAgICAgICAgIGtleXMsXG4gICAgICAgICAgICAgIG1heFRpbWVNUyxcbiAgICAgICAgICAgICAgYmF0Y2hTaXplLFxuICAgICAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICAgICAgaGludCxcbiAgICAgICAgICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgICAgICAgICBleHBsYWluLFxuICAgICAgICAgICAgICBjb21tZW50LFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICApXG4gICAgICApO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbGxhdGlvbiB0byBzdXBwb3J0IGNhc2UgaW5zZW5zaXRpdmUgcXVlcmllc1xuICAgKi9cbiAgc3RhdGljIGNhc2VJbnNlbnNpdGl2ZUNvbGxhdGlvbigpIHtcbiAgICByZXR1cm4geyBsb2NhbGU6ICdlbl9VUycsIHN0cmVuZ3RoOiAyIH07XG4gIH1cblxuICBfcmF3RmluZChcbiAgICBxdWVyeSxcbiAgICB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAga2V5cyxcbiAgICAgIG1heFRpbWVNUyxcbiAgICAgIGJhdGNoU2l6ZSxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgaGludCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgICBjb21tZW50LFxuICAgIH0gPSB7fVxuICApIHtcbiAgICBsZXQgZmluZE9wZXJhdGlvbiA9IHRoaXMuX21vbmdvQ29sbGVjdGlvbi5maW5kKHF1ZXJ5LCB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY29tbWVudCxcbiAgICAgIGJhdGNoU2l6ZSxcbiAgICB9KTtcblxuICAgIGlmIChrZXlzKSB7XG4gICAgICBmaW5kT3BlcmF0aW9uID0gZmluZE9wZXJhdGlvbi5wcm9qZWN0KGtleXMpO1xuICAgIH1cblxuICAgIGlmIChjYXNlSW5zZW5zaXRpdmUpIHtcbiAgICAgIGZpbmRPcGVyYXRpb24gPSBmaW5kT3BlcmF0aW9uLmNvbGxhdGlvbihNb25nb0NvbGxlY3Rpb24uY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uKCkpO1xuICAgIH1cblxuICAgIGlmIChtYXhUaW1lTVMpIHtcbiAgICAgIGZpbmRPcGVyYXRpb24gPSBmaW5kT3BlcmF0aW9uLm1heFRpbWVNUyhtYXhUaW1lTVMpO1xuICAgIH1cblxuICAgIHJldHVybiBleHBsYWluID8gZmluZE9wZXJhdGlvbi5leHBsYWluKGV4cGxhaW4pIDogZmluZE9wZXJhdGlvbi50b0FycmF5KCk7XG4gIH1cblxuICBjb3VudChxdWVyeSwgeyBza2lwLCBsaW1pdCwgc29ydCwgbWF4VGltZU1TLCByZWFkUHJlZmVyZW5jZSwgaGludCwgY29tbWVudCB9ID0ge30pIHtcbiAgICAvLyBJZiBxdWVyeSBpcyBlbXB0eSwgdGhlbiB1c2UgZXN0aW1hdGVkRG9jdW1lbnRDb3VudCBpbnN0ZWFkLlxuICAgIC8vIFRoaXMgaXMgZHVlIHRvIGNvdW50RG9jdW1lbnRzIHBlcmZvcm1pbmcgYSBzY2FuLFxuICAgIC8vIHdoaWNoIGdyZWF0bHkgaW5jcmVhc2VzIGV4ZWN1dGlvbiB0aW1lIHdoZW4gYmVpbmcgcnVuIG9uIGxhcmdlIGNvbGxlY3Rpb25zLlxuICAgIC8vIFNlZSBodHRwczovL2dpdGh1Yi5jb20vQXV0b21hdHRpYy9tb25nb29zZS9pc3N1ZXMvNjcxMyBmb3IgbW9yZSBpbmZvIHJlZ2FyZGluZyB0aGlzIHByb2JsZW0uXG4gICAgaWYgKHR5cGVvZiBxdWVyeSAhPT0gJ29iamVjdCcgfHwgIU9iamVjdC5rZXlzKHF1ZXJ5KS5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB0aGlzLl9tb25nb0NvbGxlY3Rpb24uZXN0aW1hdGVkRG9jdW1lbnRDb3VudCh7XG4gICAgICAgIG1heFRpbWVNUyxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLl9tb25nb0NvbGxlY3Rpb24uY291bnREb2N1bWVudHMocXVlcnksIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIHNvcnQsXG4gICAgICBtYXhUaW1lTVMsXG4gICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgIGhpbnQsXG4gICAgICBjb21tZW50LFxuICAgIH0pO1xuICB9XG5cbiAgZGlzdGluY3QoZmllbGQsIHF1ZXJ5KSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5kaXN0aW5jdChmaWVsZCwgcXVlcnkpO1xuICB9XG5cbiAgYWdncmVnYXRlKHBpcGVsaW5lLCB7IG1heFRpbWVNUywgYmF0Y2hTaXplLCByZWFkUHJlZmVyZW5jZSwgaGludCwgZXhwbGFpbiwgY29tbWVudCB9ID0ge30pIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uXG4gICAgICAuYWdncmVnYXRlKHBpcGVsaW5lLCB7IG1heFRpbWVNUywgYmF0Y2hTaXplLCByZWFkUHJlZmVyZW5jZSwgaGludCwgZXhwbGFpbiwgY29tbWVudCB9KVxuICAgICAgLnRvQXJyYXkoKTtcbiAgfVxuXG4gIGluc2VydE9uZShvYmplY3QsIHNlc3Npb24pIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmluc2VydE9uZShvYmplY3QsIHsgc2Vzc2lvbiB9KTtcbiAgfVxuXG4gIGluc2VydE1hbnkob2JqZWN0LCBzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5pbnNlcnRNYW55KG9iamVjdCwgeyBzZXNzaW9uIH0pO1xuICB9XG5cbiAgLy8gQXRvbWljYWxseSB1cGRhdGVzIGRhdGEgaW4gdGhlIGRhdGFiYXNlIGZvciBhIHNpbmdsZSAoZmlyc3QpIG9iamVjdCB0aGF0IG1hdGNoZWQgdGhlIHF1ZXJ5XG4gIC8vIElmIHRoZXJlIGlzIG5vdGhpbmcgdGhhdCBtYXRjaGVzIHRoZSBxdWVyeSAtIGRvZXMgaW5zZXJ0XG4gIC8vIFBvc3RncmVzIE5vdGU6IGBJTlNFUlQgLi4uIE9OIENPTkZMSUNUIFVQREFURWAgdGhhdCBpcyBhdmFpbGFibGUgc2luY2UgOS41LlxuICB1cHNlcnRPbmUocXVlcnksIHVwZGF0ZSwgc2Vzc2lvbikge1xuICAgIHJldHVybiB0aGlzLl9tb25nb0NvbGxlY3Rpb24udXBkYXRlT25lKHF1ZXJ5LCB1cGRhdGUsIHtcbiAgICAgIHVwc2VydDogdHJ1ZSxcbiAgICAgIHNlc3Npb24sXG4gICAgfSk7XG4gIH1cblxuICB1cGRhdGVPbmUocXVlcnksIHVwZGF0ZSkge1xuICAgIHJldHVybiB0aGlzLl9tb25nb0NvbGxlY3Rpb24udXBkYXRlT25lKHF1ZXJ5LCB1cGRhdGUpO1xuICB9XG5cbiAgdXBkYXRlTWFueShxdWVyeSwgdXBkYXRlLCBzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi51cGRhdGVNYW55KHF1ZXJ5LCB1cGRhdGUsIHsgc2Vzc2lvbiB9KTtcbiAgfVxuXG4gIGRlbGV0ZU1hbnkocXVlcnksIHNlc3Npb24pIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmRlbGV0ZU1hbnkocXVlcnksIHsgc2Vzc2lvbiB9KTtcbiAgfVxuXG4gIF9lbnN1cmVTcGFyc2VVbmlxdWVJbmRleEluQmFja2dyb3VuZChpbmRleFJlcXVlc3QpIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4KGluZGV4UmVxdWVzdCwge1xuICAgICAgdW5pcXVlOiB0cnVlLFxuICAgICAgYmFja2dyb3VuZDogdHJ1ZSxcbiAgICAgIHNwYXJzZTogdHJ1ZSxcbiAgICB9KTtcbiAgfVxuXG4gIGRyb3AoKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5kcm9wKCk7XG4gIH1cbn1cbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUFBLE1BQU1BLE9BQU8sR0FBR0MsT0FBTyxDQUFDLFNBQVMsQ0FBQztBQUNsQyxNQUFNQyxVQUFVLEdBQUdGLE9BQU8sQ0FBQ0UsVUFBVTs7QUFFckM7QUFDQTtBQUNBO0FBQ0EsTUFBTUMseUJBQXlCLEdBQUcsQ0FBQyxhQUFhLEVBQUUsT0FBTyxFQUFFLFVBQVUsQ0FBQzs7QUFFdEU7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDTyxTQUFTQyxpQkFBaUJBLENBQUNDLEtBQUssRUFBRTtFQUN2QyxJQUFJLENBQUNBLEtBQUssSUFBSSxPQUFPQSxLQUFLLEtBQUssUUFBUSxFQUFFO0lBQ3ZDLE9BQU9DLFNBQVM7RUFDbEI7RUFDQSxLQUFLLE1BQU1DLEtBQUssSUFBSUMsTUFBTSxDQUFDQyxJQUFJLENBQUNKLEtBQUssQ0FBQyxFQUFFO0lBQ3RDLE1BQU1LLEtBQUssR0FBR0wsS0FBSyxDQUFDRSxLQUFLLENBQUM7SUFDMUI7SUFDQSxJQUFJQSxLQUFLLEtBQUssTUFBTSxJQUFJSSxLQUFLLENBQUNDLE9BQU8sQ0FBQ0YsS0FBSyxDQUFDLEVBQUU7TUFDNUMsS0FBSyxNQUFN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