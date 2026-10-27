"use strict";

var equalObjects = require('./equalObjects');
var Id = require('./Id');
var Parse = require('parse/node');
var vm = require('vm');
var logger = require('../logger').default;
var regexTimeout = 0;
// IMPORTANT: vmContext is shared across all calls for performance (vm.createContext() is expensive).
// This is safe because safeRegexTest is synchronous — setting the context properties and calling
// runInContext happen in the same event loop tick with no interruption possible. Do NOT add any
// asynchronous operations (await, callbacks, promises) between setting vmContext properties and
// calling script.runInContext, as this would allow other calls to overwrite the context values
// and cause cross-contamination between regex evaluations.
var vmContext = vm.createContext(Object.create(null));
var scriptCache = new Map();
var SCRIPT_CACHE_MAX = 1000;
function setRegexTimeout(ms) {
  regexTimeout = ms;
}

// IMPORTANT: This function must remain synchronous. See vmContext comment above.
function safeRegexTest(pattern, flags, input) {
  try {
    if (!regexTimeout) {
      var re = new RegExp(pattern, flags);
      return re.test(input);
    }
    var cacheKey = flags + ':' + pattern;
    var script = scriptCache.get(cacheKey);
    if (!script) {
      if (scriptCache.size >= SCRIPT_CACHE_MAX) {
        scriptCache.clear();
      }
      script = new vm.Script('new RegExp(pattern, flags).test(input)');
      scriptCache.set(cacheKey, script);
    }
    vmContext.pattern = pattern;
    vmContext.flags = flags;
    vmContext.input = input;
    return script.runInContext(vmContext, {
      timeout: regexTimeout
    });
  } catch (e) {
    if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      logger.warn(`Regex timeout: pattern "${pattern}" with flags "${flags}" exceeded ${regexTimeout}ms limit`);
    } else {
      logger.warn(`Invalid regex: pattern "${pattern}" with flags "${flags}": ${e.message}`);
    }
    return false;
  }
}

/**
 * Query Hashes are deterministic hashes for Parse Queries.
 * Any two queries that have the same set of constraints will produce the same
 * hash. This lets us reliably group components by the queries they depend upon,
 * and quickly determine if a query has changed.
 */

// Operators whose array argument is a set, so element order carries no meaning.
// Their elements are sorted before hashing; every other array is hashed in order.
var ORDER_INSENSITIVE_OPERATORS = ['$or', '$and', '$nor', '$in', '$nin', '$all', '$containedBy'];

/**
 * Canonically serializes a query `where` into an unambiguous string. Object keys
 * are sorted so key order never affects the result, and the elements of a set
 * operator (see ORDER_INSENSITIVE_OPERATORS) are sorted so their order does not
 * either; all other array order is preserved. Keys and values are JSON-encoded,
 * so every key, the whole structure, and each value type is represented
 * distinctly. Unlike the former flatten-and-list approach, this keeps every key
 * next to `$or` (including the server-added `_Session` `user` pointer and
 * `beforeSubscribe` constraints), so queries that differ only in those keys hash
 * differently.
 */
function canonicalize(value, orderInsensitive) {
  if (Array.isArray(value)) {
    var items = value.map(function (item) {
      return canonicalize(item, false);
    });
    if (orderInsensitive) {
      items.sort();
    }
    return '[' + items.join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    var keys = Object.keys(value).sort();
    var sections = keys.map(function (key) {
      return JSON.stringify(key) + ':' + canonicalize(value[key], ORDER_INSENSITIVE_OPERATORS.indexOf(key) > -1);
    });
    return '{' + sections.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Generate a deterministic hash from a query's class name and `where` clause.
 * Any two queries with equivalent constraints produce the same hash.
 */
function queryHash(query) {
  if (query instanceof Parse.Query) {
    query = {
      className: query.className,
      where: query._where
    };
  }
  return query.className + ':' + canonicalize(query.where || {}, false);
}

/**
 * contains -- Determines if an object is contained in a list with special handling for Parse pointers.
 */
function contains(haystack, needle) {
  if (needle && needle.__type && needle.__type === 'Pointer') {
    for (const i in haystack) {
      const ptr = haystack[i];
      if (typeof ptr === 'string' && ptr === needle.objectId) {
        return true;
      }
      if (ptr.className === needle.className && ptr.objectId === needle.objectId) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(needle)) {
    for (const need of needle) {
      if (contains(haystack, need)) {
        return true;
      }
    }
  }
  return haystack.indexOf(needle) > -1;
}
/**
 * matchesQuery -- Determines if an object would be returned by a Parse Query
 * It's a lightweight, where-clause only implementation of a full query engine.
 * Since we find queries that match objects, rather than objects that match
 * queries, we can avoid building a full-blown query tool.
 */
function matchesQuery(object, query) {
  if (query instanceof Parse.Query) {
    var className = object.id instanceof Id ? object.id.className : object.className;
    if (className !== query.className) {
      return false;
    }
    return matchesQuery(object, query._where);
  }
  for (var field in query) {
    if (!matchesKeyConstraints(object, field, query[field])) {
      return false;
    }
  }
  return true;
}
function equalObjectsGeneric(obj, compareTo, eqlFn) {
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      if (eqlFn(obj[i], compareTo)) {
        return true;
      }
    }
    return false;
  }
  return eqlFn(obj, compareTo);
}

/**
 * Determines whether an object matches a single key's constraints
 */
function matchesKeyConstraints(object, key, constraints) {
  if (constraints === null) {
    return false;
  }
  if (key.indexOf('.') >= 0) {
    // Key references a subobject
    var keyComponents = key.split('.');
    var subObjectKey = keyComponents[0];
    var keyRemainder = keyComponents.slice(1).join('.');
    return matchesKeyConstraints(object[subObjectKey] || {}, keyRemainder, constraints);
  }
  var i;
  if (key === '$or') {
    if (!Array.isArray(constraints)) {
      return false;
    }
    for (i = 0; i < constraints.length; i++) {
      if (matchesQuery(object, constraints[i])) {
        return true;
      }
    }
    return false;
  }
  if (key === '$and') {
    if (!Array.isArray(constraints)) {
      return false;
    }
    for (i = 0; i < constraints.length; i++) {
      if (!matchesQuery(object, constraints[i])) {
        return false;
      }
    }
    return true;
  }
  if (key === '$nor') {
    if (!Array.isArray(constraints)) {
      return false;
    }
    for (i = 0; i < constraints.length; i++) {
      if (matchesQuery(object, constraints[i])) {
        return false;
      }
    }
    return true;
  }
  if (key === '$relatedTo') {
    // Bail! We can't handle relational queries locally
    return false;
  }
  // Decode Date JSON value
  if (object[key] && object[key].__type == 'Date') {
    object[key] = new Date(object[key].iso);
  }
  // Equality (or Array contains) cases
  if (typeof constraints !== 'object') {
    if (Array.isArray(object[key])) {
      return object[key].indexOf(constraints) > -1;
    }
    return object[key] === constraints;
  }
  var compareTo;
  if (constraints.__type) {
    if (constraints.__type === 'Pointer') {
      return equalObjectsGeneric(object[key], constraints, function (obj, ptr) {
        return typeof obj !== 'undefined' && ptr.className === obj.className && ptr.objectId === obj.objectId;
      });
    }
    return equalObjectsGeneric(object[key], Parse._decode(key, constraints), equalObjects);
  }
  // More complex cases
  for (var condition in constraints) {
    compareTo = constraints[condition];
    if (compareTo?.__type) {
      compareTo = Parse._decode(key, compareTo);
    }
    switch (condition) {
      case '$lt':
        if (object[key] >= compareTo) {
          return false;
        }
        break;
      case '$lte':
        if (object[key] > compareTo) {
          return false;
        }
        break;
      case '$gt':
        if (object[key] <= compareTo) {
          return false;
        }
        break;
      case '$gte':
        if (object[key] < compareTo) {
          return false;
        }
        break;
      case '$eq':
        if (!equalObjects(object[key], compareTo)) {
          return false;
        }
        break;
      case '$ne':
        if (equalObjects(object[key], compareTo)) {
          return false;
        }
        break;
      case '$in':
        if (!contains(compareTo, object[key])) {
          return false;
        }
        break;
      case '$nin':
        if (contains(compareTo, object[key])) {
          return false;
        }
        break;
      case '$all':
        if (!object[key]) {
          return false;
        }
        for (i = 0; i < compareTo.length; i++) {
          if (object[key].indexOf(compareTo[i]) < 0) {
            return false;
          }
        }
        break;
      case '$exists':
        {
          const propertyExists = typeof object[key] !== 'undefined';
          const existenceIsRequired = constraints['$exists'];
          if (typeof constraints['$exists'] !== 'boolean') {
            // The SDK will never submit a non-boolean for $exists, but if someone
            // tries to submit a non-boolean for $exits outside the SDKs, just ignore it.
            break;
          }
          if (!propertyExists && existenceIsRequired || propertyExists && !existenceIsRequired) {
            return false;
          }
          break;
        }
      case '$regex':
        {
          if (typeof compareTo === 'object') {
            if (!safeRegexTest(compareTo.source, compareTo.flags, object[key])) {
              return false;
            }
            break;
          }
          // JS doesn't support perl-style escaping
          var expString = '';
          var escapeEnd = -2;
          var escapeStart = compareTo.indexOf('\\Q');
          while (escapeStart > -1) {
            // Add the unescaped portion
            expString += compareTo.substring(escapeEnd + 2, escapeStart);
            escapeEnd = compareTo.indexOf('\\E', escapeStart);
            if (escapeEnd > -1) {
              expString += compareTo.substring(escapeStart + 2, escapeEnd).replace(/\\\\\\\\E/g, '\\E').replace(/\W/g, '\\$&');
            }
            escapeStart = compareTo.indexOf('\\Q', escapeEnd);
          }
          expString += compareTo.substring(Math.max(escapeStart, escapeEnd + 2));
          if (!safeRegexTest(expString, constraints.$options || '', object[key])) {
            return false;
          }
          break;
        }
      case '$nearSphere':
        if (!compareTo || !object[key]) {
          return false;
        }
        var distance = compareTo.radiansTo(object[key]);
        var max = constraints.$maxDistance || Infinity;
        return distance <= max;
      case '$within':
        if (!compareTo || !object[key]) {
          return false;
        }
        var southWest = compareTo.$box[0];
        var northEast = compareTo.$box[1];
        if (southWest.latitude > northEast.latitude || southWest.longitude > northEast.longitude) {
          // Invalid box, crosses the date line
          return false;
        }
        return object[key].latitude > southWest.latitude && object[key].latitude < northEast.latitude && object[key].longitude > southWest.longitude && object[key].longitude < northEast.longitude;
      case '$containedBy':
        {
          for (const value of object[key]) {
            if (!contains(compareTo, value)) {
              return false;
            }
          }
          return true;
        }
      case '$geoWithin':
        {
          if (compareTo.$polygon) {
            const points = compareTo.$polygon.map(geoPoint => [geoPoint.latitude, geoPoint.longitude]);
            const polygon = new Parse.Polygon(points);
            return polygon.containsPoint(object[key]);
          }
          if (compareTo.$centerSphere) {
            const [WGS84Point, maxDistance] = compareTo.$centerSphere;
            const centerPoint = new Parse.GeoPoint({
              latitude: WGS84Point[1],
              longitude: WGS84Point[0]
            });
            const point = new Parse.GeoPoint(object[key]);
            const distance = point.radiansTo(centerPoint);
            return distance <= maxDistance;
          }
          break;
        }
      case '$geoIntersects':
        {
          const polygon = new Parse.Polygon(object[key].coordinates);
          const point = new Parse.GeoPoint(compareTo.$point);
          return polygon.containsPoint(point);
        }
      case '$options':
        // Not a query type, but a way to add options to $regex. Ignore and
        // avoid the default
        break;
      case '$maxDistance':
        // Not a query type, but a way to add a cap to $nearSphere. Ignore and
        // avoid the default
        break;
      case '$select':
        return false;
      case '$dontSelect':
        return false;
      default:
        return false;
    }
  }
  return true;
}
var QueryTools = {
  queryHash: queryHash,
  matchesQuery: matchesQuery,
  setRegexTimeout: setRegexTimeout
};
module.exports = QueryTools;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJlcXVhbE9iamVjdHMiLCJyZXF1aXJlIiwiSWQiLCJQYXJzZSIsInZtIiwibG9nZ2VyIiwiZGVmYXVsdCIsInJlZ2V4VGltZW91dCIsInZtQ29udGV4dCIsImNyZWF0ZUNvbnRleHQiLCJPYmplY3QiLCJjcmVhdGUiLCJzY3JpcHRDYWNoZSIsIk1hcCIsIlNDUklQVF9DQUNIRV9NQVgiLCJzZXRSZWdleFRpbWVvdXQiLCJtcyIsInNhZmVSZWdleFRlc3QiLCJwYXR0ZXJuIiwiZmxhZ3MiLCJpbnB1dCIsInJlIiwiUmVnRXhwIiwidGVzdCIsImNhY2hlS2V5Iiwic2NyaXB0IiwiZ2V0Iiwic2l6ZSIsImNsZWFyIiwiU2NyaXB0Iiwic2V0IiwicnVuSW5Db250ZXh0IiwidGltZW91dCIsImUiLCJjb2RlIiwid2FybiIsIm1lc3NhZ2UiLCJPUkRFUl9JTlNFTlNJVElWRV9PUEVSQVRPUlMiLCJjYW5vbmljYWxpemUiLCJ2YWx1ZSIsIm9yZGVySW5zZW5zaXRpdmUiLCJBcnJheSIsImlzQXJyYXkiLCJpdGVtcyIsIm1hcCIsIml0ZW0iLCJzb3J0Iiwiam9pbiIsImtleXMiLCJzZWN0aW9ucyIsImtleSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpbmRleE9mIiwicXVlcnlIYXNoIiwicXVlcnkiLCJRdWVyeSIsImNsYXNzTmFtZSIsIndoZXJlIiwiX3doZXJlIiwiY29udGFpbnMiLCJoYXlzdGFjayIsIm5lZWRsZSIsIl9fdHlwZSIsImkiLCJwdHIiLCJvYmplY3RJZCIsIm5lZWQiLCJtYXRjaGVzUXVlcnkiLCJvYmplY3QiLCJpZCIsImZpZWxkIiwibWF0Y2hlc0tleUNvbnN0cmFpbnRzIiwiZXF1YWxPYmplY3RzR2VuZXJpYyIsIm9iaiIsImNvbXBhcmVUbyIsImVxbEZuIiwibGVuZ3RoIiwiY29uc3RyYWludHMiLCJrZXlDb21wb25lbnRzIiwic3BsaXQiLCJzdWJPYmplY3RLZXkiLCJrZXlSZW1haW5kZXIiLCJzbGljZSIsIkRhdGUiLCJpc28iLCJfZGVjb2RlIiwiY29uZGl0aW9uIiwicHJvcGVydHlFeGlzdHMiLCJleGlzdGVuY2VJc1JlcXVpcmVkIiwic291cmNlIiwiZXhwU3RyaW5nIiwiZXNjYXBlRW5kIiwiZXNjYXBlU3RhcnQiLCJzdWJzdHJpbmciLCJyZXBsYWNlIiwiTWF0aCIsIm1heCIsIiRvcHRpb25zIiwiZGlzdGFuY2UiLCJyYWRpYW5zVG8iLCIkbWF4RGlzdGFuY2UiLCJJbmZpbml0eSIsInNvdXRoV2VzdCIsIiRib3giLCJub3J0aEVhc3QiLCJsYXRpdHVkZSIsImxvbmdpdHVkZSIsIiRwb2x5Z29uIiwicG9pbnRzIiwiZ2VvUG9pbnQiLCJwb2x5Z29uIiwiUG9seWdvbiIsImNvbnRhaW5zUG9pbnQiLCIkY2VudGVyU3BoZXJlIiwiV0dTODRQb2ludCIsIm1heERpc3RhbmNlIiwiY2VudGVyUG9pbnQiLCJHZW9Qb2ludCIsInBvaW50IiwiY29vcmRpbmF0ZXMiLCIkcG9pbnQiLCJRdWVyeVRvb2xzIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9MaXZlUXVlcnkvUXVlcnlUb29scy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJ2YXIgZXF1YWxPYmplY3RzID0gcmVxdWlyZSgnLi9lcXVhbE9iamVjdHMnKTtcbnZhciBJZCA9IHJlcXVpcmUoJy4vSWQnKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKTtcbnZhciB2bSA9IHJlcXVpcmUoJ3ZtJyk7XG52YXIgbG9nZ2VyID0gcmVxdWlyZSgnLi4vbG9nZ2VyJykuZGVmYXVsdDtcblxudmFyIHJlZ2V4VGltZW91dCA9IDA7XG4vLyBJTVBPUlRBTlQ6IHZtQ29udGV4dCBpcyBzaGFyZWQgYWNyb3NzIGFsbCBjYWxscyBmb3IgcGVyZm9ybWFuY2UgKHZtLmNyZWF0ZUNvbnRleHQoKSBpcyBleHBlbnNpdmUpLlxuLy8gVGhpcyBpcyBzYWZlIGJlY2F1c2Ugc2FmZVJlZ2V4VGVzdCBpcyBzeW5jaHJvbm91cyDigJQgc2V0dGluZyB0aGUgY29udGV4dCBwcm9wZXJ0aWVzIGFuZCBjYWxsaW5nXG4vLyBydW5JbkNvbnRleHQgaGFwcGVuIGluIHRoZSBzYW1lIGV2ZW50IGxvb3AgdGljayB3aXRoIG5vIGludGVycnVwdGlvbiBwb3NzaWJsZS4gRG8gTk9UIGFkZCBhbnlcbi8vIGFzeW5jaHJvbm91cyBvcGVyYXRpb25zIChhd2FpdCwgY2FsbGJhY2tzLCBwcm9taXNlcykgYmV0d2VlbiBzZXR0aW5nIHZtQ29udGV4dCBwcm9wZXJ0aWVzIGFuZFxuLy8gY2FsbGluZyBzY3JpcHQucnVuSW5Db250ZXh0LCBhcyB0aGlzIHdvdWxkIGFsbG93IG90aGVyIGNhbGxzIHRvIG92ZXJ3cml0ZSB0aGUgY29udGV4dCB2YWx1ZXNcbi8vIGFuZCBjYXVzZSBjcm9zcy1jb250YW1pbmF0aW9uIGJldHdlZW4gcmVnZXggZXZhbHVhdGlvbnMuXG52YXIgdm1Db250ZXh0ID0gdm0uY3JlYXRlQ29udGV4dChPYmplY3QuY3JlYXRlKG51bGwpKTtcbnZhciBzY3JpcHRDYWNoZSA9IG5ldyBNYXAoKTtcbnZhciBTQ1JJUFRfQ0FDSEVfTUFYID0gMTAwMDtcblxuZnVuY3Rpb24gc2V0UmVnZXhUaW1lb3V0KG1zKSB7XG4gIHJlZ2V4VGltZW91dCA9IG1zO1xufVxuXG4vLyBJTVBPUlRBTlQ6IFRoaXMgZnVuY3Rpb24gbXVzdCByZW1haW4gc3luY2hyb25vdXMuIFNlZSB2bUNvbnRleHQgY29tbWVudCBhYm92ZS5cbmZ1bmN0aW9uIHNhZmVSZWdleFRlc3QocGF0dGVybiwgZmxhZ3MsIGlucHV0KSB7XG4gIHRyeSB7XG4gICAgaWYgKCFyZWdleFRpbWVvdXQpIHtcbiAgICAgIHZhciByZSA9IG5ldyBSZWdFeHAocGF0dGVybiwgZmxhZ3MpO1xuICAgICAgcmV0dXJuIHJlLnRlc3QoaW5wdXQpO1xuICAgIH1cbiAgICB2YXIgY2FjaGVLZXkgPSBmbGFncyArICc6JyArIHBhdHRlcm47XG4gICAgdmFyIHNjcmlwdCA9IHNjcmlwdENhY2hlLmdldChjYWNoZUtleSk7XG4gICAgaWYgKCFzY3JpcHQpIHtcbiAgICAgIGlmIChzY3JpcHRDYWNoZS5zaXplID49IFNDUklQVF9DQUNIRV9NQVgpIHsgc2NyaXB0Q2FjaGUuY2xlYXIoKTsgfVxuICAgICAgc2NyaXB0ID0gbmV3IHZtLlNjcmlwdCgnbmV3IFJlZ0V4cChwYXR0ZXJuLCBmbGFncykudGVzdChpbnB1dCknKTtcbiAgICAgIHNjcmlwdENhY2hlLnNldChjYWNoZUtleSwgc2NyaXB0KTtcbiAgICB9XG4gICAgdm1Db250ZXh0LnBhdHRlcm4gPSBwYXR0ZXJuO1xuICAgIHZtQ29udGV4dC5mbGFncyA9IGZsYWdzO1xuICAgIHZtQ29udGV4dC5pbnB1dCA9IGlucHV0O1xuICAgIHJldHVybiBzY3JpcHQucnVuSW5Db250ZXh0KHZtQ29udGV4dCwgeyB0aW1lb3V0OiByZWdleFRpbWVvdXQgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZS5jb2RlID09PSAnRVJSX1NDUklQVF9FWEVDVVRJT05fVElNRU9VVCcpIHtcbiAgICAgIGxvZ2dlci53YXJuKGBSZWdleCB0aW1lb3V0OiBwYXR0ZXJuIFwiJHtwYXR0ZXJufVwiIHdpdGggZmxhZ3MgXCIke2ZsYWdzfVwiIGV4Y2VlZGVkICR7cmVnZXhUaW1lb3V0fW1zIGxpbWl0YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZ2dlci53YXJuKGBJbnZhbGlkIHJlZ2V4OiBwYXR0ZXJuIFwiJHtwYXR0ZXJufVwiIHdpdGggZmxhZ3MgXCIke2ZsYWdzfVwiOiAke2UubWVzc2FnZX1gKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogUXVlcnkgSGFzaGVzIGFyZSBkZXRlcm1pbmlzdGljIGhhc2hlcyBmb3IgUGFyc2UgUXVlcmllcy5cbiAqIEFueSB0d28gcXVlcmllcyB0aGF0IGhhdmUgdGhlIHNhbWUgc2V0IG9mIGNvbnN0cmFpbnRzIHdpbGwgcHJvZHVjZSB0aGUgc2FtZVxuICogaGFzaC4gVGhpcyBsZXRzIHVzIHJlbGlhYmx5IGdyb3VwIGNvbXBvbmVudHMgYnkgdGhlIHF1ZXJpZXMgdGhleSBkZXBlbmQgdXBvbixcbiAqIGFuZCBxdWlja2x5IGRldGVybWluZSBpZiBhIHF1ZXJ5IGhhcyBjaGFuZ2VkLlxuICovXG5cbi8vIE9wZXJhdG9ycyB3aG9zZSBhcnJheSBhcmd1bWVudCBpcyBhIHNldCwgc28gZWxlbWVudCBvcmRlciBjYXJyaWVzIG5vIG1lYW5pbmcuXG4vLyBUaGVpciBlbGVtZW50cyBhcmUgc29ydGVkIGJlZm9yZSBoYXNoaW5nOyBldmVyeSBvdGhlciBhcnJheSBpcyBoYXNoZWQgaW4gb3JkZXIuXG52YXIgT1JERVJfSU5TRU5TSVRJVkVfT1BFUkFUT1JTID0gWyckb3InLCAnJGFuZCcsICckbm9yJywgJyRpbicsICckbmluJywgJyRhbGwnLCAnJGNvbnRhaW5lZEJ5J107XG5cbi8qKlxuICogQ2Fub25pY2FsbHkgc2VyaWFsaXplcyBhIHF1ZXJ5IGB3aGVyZWAgaW50byBhbiB1bmFtYmlndW91cyBzdHJpbmcuIE9iamVjdCBrZXlzXG4gKiBhcmUgc29ydGVkIHNvIGtleSBvcmRlciBuZXZlciBhZmZlY3RzIHRoZSByZXN1bHQsIGFuZCB0aGUgZWxlbWVudHMgb2YgYSBzZXRcbiAqIG9wZXJhdG9yIChzZWUgT1JERVJfSU5TRU5TSVRJVkVfT1BFUkFUT1JTKSBhcmUgc29ydGVkIHNvIHRoZWlyIG9yZGVyIGRvZXMgbm90XG4gKiBlaXRoZXI7IGFsbCBvdGhlciBhcnJheSBvcmRlciBpcyBwcmVzZXJ2ZWQuIEtleXMgYW5kIHZhbHVlcyBhcmUgSlNPTi1lbmNvZGVkLFxuICogc28gZXZlcnkga2V5LCB0aGUgd2hvbGUgc3RydWN0dXJlLCBhbmQgZWFjaCB2YWx1ZSB0eXBlIGlzIHJlcHJlc2VudGVkXG4gKiBkaXN0aW5jdGx5LiBVbmxpa2UgdGhlIGZvcm1lciBmbGF0dGVuLWFuZC1saXN0IGFwcHJvYWNoLCB0aGlzIGtlZXBzIGV2ZXJ5IGtleVxuICogbmV4dCB0byBgJG9yYCAoaW5jbHVkaW5nIHRoZSBzZXJ2ZXItYWRkZWQgYF9TZXNzaW9uYCBgdXNlcmAgcG9pbnRlciBhbmRcbiAqIGBiZWZvcmVTdWJzY3JpYmVgIGNvbnN0cmFpbnRzKSwgc28gcXVlcmllcyB0aGF0IGRpZmZlciBvbmx5IGluIHRob3NlIGtleXMgaGFzaFxuICogZGlmZmVyZW50bHkuXG4gKi9cbmZ1bmN0aW9uIGNhbm9uaWNhbGl6ZSh2YWx1ZSwgb3JkZXJJbnNlbnNpdGl2ZSkge1xuICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICB2YXIgaXRlbXMgPSB2YWx1ZS5tYXAoZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgIHJldHVybiBjYW5vbmljYWxpemUoaXRlbSwgZmFsc2UpO1xuICAgIH0pO1xuICAgIGlmIChvcmRlckluc2Vuc2l0aXZlKSB7XG4gICAgICBpdGVtcy5zb3J0KCk7XG4gICAgfVxuICAgIHJldHVybiAnWycgKyBpdGVtcy5qb2luKCcsJykgKyAnXSc7XG4gIH1cbiAgaWYgKHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKS5zb3J0KCk7XG4gICAgdmFyIHNlY3Rpb25zID0ga2V5cy5tYXAoZnVuY3Rpb24gKGtleSkge1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGtleSkgKyAnOicgKyBjYW5vbmljYWxpemUodmFsdWVba2V5XSwgT1JERVJfSU5TRU5TSVRJVkVfT1BFUkFUT1JTLmluZGV4T2Yoa2V5KSA+IC0xKTtcbiAgICB9KTtcbiAgICByZXR1cm4gJ3snICsgc2VjdGlvbnMuam9pbignLCcpICsgJ30nO1xuICB9XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG59XG5cbi8qKlxuICogR2VuZXJhdGUgYSBkZXRlcm1pbmlzdGljIGhhc2ggZnJvbSBhIHF1ZXJ5J3MgY2xhc3MgbmFtZSBhbmQgYHdoZXJlYCBjbGF1c2UuXG4gKiBBbnkgdHdvIHF1ZXJpZXMgd2l0aCBlcXVpdmFsZW50IGNvbnN0cmFpbnRzIHByb2R1Y2UgdGhlIHNhbWUgaGFzaC5cbiAqL1xuZnVuY3Rpb24gcXVlcnlIYXNoKHF1ZXJ5KSB7XG4gIGlmIChxdWVyeSBpbnN0YW5jZW9mIFBhcnNlLlF1ZXJ5KSB7XG4gICAgcXVlcnkgPSB7XG4gICAgICBjbGFzc05hbWU6IHF1ZXJ5LmNsYXNzTmFtZSxcbiAgICAgIHdoZXJlOiBxdWVyeS5fd2hlcmUsXG4gICAgfTtcbiAgfVxuICByZXR1cm4gcXVlcnkuY2xhc3NOYW1lICsgJzonICsgY2Fub25pY2FsaXplKHF1ZXJ5LndoZXJlIHx8IHt9LCBmYWxzZSk7XG59XG5cbi8qKlxuICogY29udGFpbnMgLS0gRGV0ZXJtaW5lcyBpZiBhbiBvYmplY3QgaXMgY29udGFpbmVkIGluIGEgbGlzdCB3aXRoIHNwZWNpYWwgaGFuZGxpbmcgZm9yIFBhcnNlIHBvaW50ZXJzLlxuICovXG5mdW5jdGlvbiBjb250YWlucyhoYXlzdGFjazogQXJyYXksIG5lZWRsZTogYW55KTogYm9vbGVhbiB7XG4gIGlmIChuZWVkbGUgJiYgbmVlZGxlLl9fdHlwZSAmJiBuZWVkbGUuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICBmb3IgKGNvbnN0IGkgaW4gaGF5c3RhY2spIHtcbiAgICAgIGNvbnN0IHB0ciA9IGhheXN0YWNrW2ldO1xuICAgICAgaWYgKHR5cGVvZiBwdHIgPT09ICdzdHJpbmcnICYmIHB0ciA9PT0gbmVlZGxlLm9iamVjdElkKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKHB0ci5jbGFzc05hbWUgPT09IG5lZWRsZS5jbGFzc05hbWUgJiYgcHRyLm9iamVjdElkID09PSBuZWVkbGUub2JqZWN0SWQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKEFycmF5LmlzQXJyYXkobmVlZGxlKSkge1xuICAgIGZvciAoY29uc3QgbmVlZCBvZiBuZWVkbGUpIHtcbiAgICAgIGlmIChjb250YWlucyhoYXlzdGFjaywgbmVlZCkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGhheXN0YWNrLmluZGV4T2YobmVlZGxlKSA+IC0xO1xufVxuLyoqXG4gKiBtYXRjaGVzUXVlcnkgLS0gRGV0ZXJtaW5lcyBpZiBhbiBvYmplY3Qgd291bGQgYmUgcmV0dXJuZWQgYnkgYSBQYXJzZSBRdWVyeVxuICogSXQncyBhIGxpZ2h0d2VpZ2h0LCB3aGVyZS1jbGF1c2Ugb25seSBpbXBsZW1lbnRhdGlvbiBvZiBhIGZ1bGwgcXVlcnkgZW5naW5lLlxuICogU2luY2Ugd2UgZmluZCBxdWVyaWVzIHRoYXQgbWF0Y2ggb2JqZWN0cywgcmF0aGVyIHRoYW4gb2JqZWN0cyB0aGF0IG1hdGNoXG4gKiBxdWVyaWVzLCB3ZSBjYW4gYXZvaWQgYnVpbGRpbmcgYSBmdWxsLWJsb3duIHF1ZXJ5IHRvb2wuXG4gKi9cbmZ1bmN0aW9uIG1hdGNoZXNRdWVyeShvYmplY3Q6IGFueSwgcXVlcnk6IGFueSk6IGJvb2xlYW4ge1xuICBpZiAocXVlcnkgaW5zdGFuY2VvZiBQYXJzZS5RdWVyeSkge1xuICAgIHZhciBjbGFzc05hbWUgPSBvYmplY3QuaWQgaW5zdGFuY2VvZiBJZCA/IG9iamVjdC5pZC5jbGFzc05hbWUgOiBvYmplY3QuY2xhc3NOYW1lO1xuICAgIGlmIChjbGFzc05hbWUgIT09IHF1ZXJ5LmNsYXNzTmFtZSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gbWF0Y2hlc1F1ZXJ5KG9iamVjdCwgcXVlcnkuX3doZXJlKTtcbiAgfVxuICBmb3IgKHZhciBmaWVsZCBpbiBxdWVyeSkge1xuICAgIGlmICghbWF0Y2hlc0tleUNvbnN0cmFpbnRzKG9iamVjdCwgZmllbGQsIHF1ZXJ5W2ZpZWxkXSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIGVxdWFsT2JqZWN0c0dlbmVyaWMob2JqLCBjb21wYXJlVG8sIGVxbEZuKSB7XG4gIGlmIChBcnJheS5pc0FycmF5KG9iaikpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9iai5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKGVxbEZuKG9ialtpXSwgY29tcGFyZVRvKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIGVxbEZuKG9iaiwgY29tcGFyZVRvKTtcbn1cblxuLyoqXG4gKiBEZXRlcm1pbmVzIHdoZXRoZXIgYW4gb2JqZWN0IG1hdGNoZXMgYSBzaW5nbGUga2V5J3MgY29uc3RyYWludHNcbiAqL1xuZnVuY3Rpb24gbWF0Y2hlc0tleUNvbnN0cmFpbnRzKG9iamVjdCwga2V5LCBjb25zdHJhaW50cykge1xuICBpZiAoY29uc3RyYWludHMgPT09IG51bGwpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKGtleS5pbmRleE9mKCcuJykgPj0gMCkge1xuICAgIC8vIEtleSByZWZlcmVuY2VzIGEgc3Vib2JqZWN0XG4gICAgdmFyIGtleUNvbXBvbmVudHMgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICB2YXIgc3ViT2JqZWN0S2V5ID0ga2V5Q29tcG9uZW50c1swXTtcbiAgICB2YXIga2V5UmVtYWluZGVyID0ga2V5Q29tcG9uZW50cy5zbGljZSgxKS5qb2luKCcuJyk7XG4gICAgcmV0dXJuIG1hdGNoZXNLZXlDb25zdHJhaW50cyhvYmplY3Rbc3ViT2JqZWN0S2V5XSB8fCB7fSwga2V5UmVtYWluZGVyLCBjb25zdHJhaW50cyk7XG4gIH1cbiAgdmFyIGk7XG4gIGlmIChrZXkgPT09ICckb3InKSB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGNvbnN0cmFpbnRzKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBmb3IgKGkgPSAwOyBpIDwgY29uc3RyYWludHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGlmIChtYXRjaGVzUXVlcnkob2JqZWN0LCBjb25zdHJhaW50c1tpXSkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoa2V5ID09PSAnJGFuZCcpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoY29uc3RyYWludHMpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGZvciAoaSA9IDA7IGkgPCBjb25zdHJhaW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKCFtYXRjaGVzUXVlcnkob2JqZWN0LCBjb25zdHJhaW50c1tpXSkpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoa2V5ID09PSAnJG5vcicpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoY29uc3RyYWludHMpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGZvciAoaSA9IDA7IGkgPCBjb25zdHJhaW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKG1hdGNoZXNRdWVyeShvYmplY3QsIGNvbnN0cmFpbnRzW2ldKSkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChrZXkgPT09ICckcmVsYXRlZFRvJykge1xuICAgIC8vIEJhaWwhIFdlIGNhbid0IGhhbmRsZSByZWxhdGlvbmFsIHF1ZXJpZXMgbG9jYWxseVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICAvLyBEZWNvZGUgRGF0ZSBKU09OIHZhbHVlXG4gIGlmIChvYmplY3Rba2V5XSAmJiBvYmplY3Rba2V5XS5fX3R5cGUgPT0gJ0RhdGUnKSB7XG4gICAgb2JqZWN0W2tleV0gPSBuZXcgRGF0ZShvYmplY3Rba2V5XS5pc28pO1xuICB9XG4gIC8vIEVxdWFsaXR5IChvciBBcnJheSBjb250YWlucykgY2FzZXNcbiAgaWYgKHR5cGVvZiBjb25zdHJhaW50cyAhPT0gJ29iamVjdCcpIHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShvYmplY3Rba2V5XSkpIHtcbiAgICAgIHJldHVybiBvYmplY3Rba2V5XS5pbmRleE9mKGNvbnN0cmFpbnRzKSA+IC0xO1xuICAgIH1cbiAgICByZXR1cm4gb2JqZWN0W2tleV0gPT09IGNvbnN0cmFpbnRzO1xuICB9XG4gIHZhciBjb21wYXJlVG87XG4gIGlmIChjb25zdHJhaW50cy5fX3R5cGUpIHtcbiAgICBpZiAoY29uc3RyYWludHMuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgIHJldHVybiBlcXVhbE9iamVjdHNHZW5lcmljKG9iamVjdFtrZXldLCBjb25zdHJhaW50cywgZnVuY3Rpb24gKG9iaiwgcHRyKSB7XG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgdHlwZW9mIG9iaiAhPT0gJ3VuZGVmaW5lZCcgJiZcbiAgICAgICAgICBwdHIuY2xhc3NOYW1lID09PSBvYmouY2xhc3NOYW1lICYmXG4gICAgICAgICAgcHRyLm9iamVjdElkID09PSBvYmoub2JqZWN0SWRcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBlcXVhbE9iamVjdHNHZW5lcmljKG9iamVjdFtrZXldLCBQYXJzZS5fZGVjb2RlKGtleSwgY29uc3RyYWludHMpLCBlcXVhbE9iamVjdHMpO1xuICB9XG4gIC8vIE1vcmUgY29tcGxleCBjYXNlc1xuICBmb3IgKHZhciBjb25kaXRpb24gaW4gY29uc3RyYWludHMpIHtcbiAgICBjb21wYXJlVG8gPSBjb25zdHJhaW50c1tjb25kaXRpb25dO1xuICAgIGlmIChjb21wYXJlVG8/Ll9fdHlwZSkge1xuICAgICAgY29tcGFyZVRvID0gUGFyc2UuX2RlY29kZShrZXksIGNvbXBhcmVUbyk7XG4gICAgfVxuICAgIHN3aXRjaCAoY29uZGl0aW9uKSB7XG4gICAgICBjYXNlICckbHQnOlxuICAgICAgICBpZiAob2JqZWN0W2tleV0gPj0gY29tcGFyZVRvKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgIGlmIChvYmplY3Rba2V5XSA+IGNvbXBhcmVUbykge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgIGlmIChvYmplY3Rba2V5XSA8PSBjb21wYXJlVG8pIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgaWYgKG9iamVjdFtrZXldIDwgY29tcGFyZVRvKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnJGVxJzpcbiAgICAgICAgaWYgKCFlcXVhbE9iamVjdHMob2JqZWN0W2tleV0sIGNvbXBhcmVUbykpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICckbmUnOlxuICAgICAgICBpZiAoZXF1YWxPYmplY3RzKG9iamVjdFtrZXldLCBjb21wYXJlVG8pKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnJGluJzpcbiAgICAgICAgaWYgKCFjb250YWlucyhjb21wYXJlVG8sIG9iamVjdFtrZXldKSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICBpZiAoY29udGFpbnMoY29tcGFyZVRvLCBvYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICckYWxsJzpcbiAgICAgICAgaWYgKCFvYmplY3Rba2V5XSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGkgPSAwOyBpIDwgY29tcGFyZVRvLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgaWYgKG9iamVjdFtrZXldLmluZGV4T2YoY29tcGFyZVRvW2ldKSA8IDApIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICckZXhpc3RzJzoge1xuICAgICAgICBjb25zdCBwcm9wZXJ0eUV4aXN0cyA9IHR5cGVvZiBvYmplY3Rba2V5XSAhPT0gJ3VuZGVmaW5lZCc7XG4gICAgICAgIGNvbnN0IGV4aXN0ZW5jZUlzUmVxdWlyZWQgPSBjb25zdHJhaW50c1snJGV4aXN0cyddO1xuICAgICAgICBpZiAodHlwZW9mIGNvbnN0cmFpbnRzWyckZXhpc3RzJ10gIT09ICdib29sZWFuJykge1xuICAgICAgICAgIC8vIFRoZSBTREsgd2lsbCBuZXZlciBzdWJtaXQgYSBub24tYm9vbGVhbiBmb3IgJGV4aXN0cywgYnV0IGlmIHNvbWVvbmVcbiAgICAgICAgICAvLyB0cmllcyB0byBzdWJtaXQgYSBub24tYm9vbGVhbiBmb3IgJGV4aXRzIG91dHNpZGUgdGhlIFNES3MsIGp1c3QgaWdub3JlIGl0LlxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGlmICgoIXByb3BlcnR5RXhpc3RzICYmIGV4aXN0ZW5jZUlzUmVxdWlyZWQpIHx8IChwcm9wZXJ0eUV4aXN0cyAmJiAhZXhpc3RlbmNlSXNSZXF1aXJlZCkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICckcmVnZXgnOiB7XG4gICAgICAgIGlmICh0eXBlb2YgY29tcGFyZVRvID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgIGlmICghc2FmZVJlZ2V4VGVzdChjb21wYXJlVG8uc291cmNlLCBjb21wYXJlVG8uZmxhZ3MsIG9iamVjdFtrZXldKSkge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICAvLyBKUyBkb2Vzbid0IHN1cHBvcnQgcGVybC1zdHlsZSBlc2NhcGluZ1xuICAgICAgICB2YXIgZXhwU3RyaW5nID0gJyc7XG4gICAgICAgIHZhciBlc2NhcGVFbmQgPSAtMjtcbiAgICAgICAgdmFyIGVzY2FwZVN0YXJ0ID0gY29tcGFyZVRvLmluZGV4T2YoJ1xcXFxRJyk7XG4gICAgICAgIHdoaWxlIChlc2NhcGVTdGFydCA+IC0xKSB7XG4gICAgICAgICAgLy8gQWRkIHRoZSB1bmVzY2FwZWQgcG9ydGlvblxuICAgICAgICAgIGV4cFN0cmluZyArPSBjb21wYXJlVG8uc3Vic3RyaW5nKGVzY2FwZUVuZCArIDIsIGVzY2FwZVN0YXJ0KTtcbiAgICAgICAgICBlc2NhcGVFbmQgPSBjb21wYXJlVG8uaW5kZXhPZignXFxcXEUnLCBlc2NhcGVTdGFydCk7XG4gICAgICAgICAgaWYgKGVzY2FwZUVuZCA+IC0xKSB7XG4gICAgICAgICAgICBleHBTdHJpbmcgKz0gY29tcGFyZVRvXG4gICAgICAgICAgICAgIC5zdWJzdHJpbmcoZXNjYXBlU3RhcnQgKyAyLCBlc2NhcGVFbmQpXG4gICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXFxcXFxcXFxcXFxcRS9nLCAnXFxcXEUnKVxuICAgICAgICAgICAgICAucmVwbGFjZSgvXFxXL2csICdcXFxcJCYnKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBlc2NhcGVTdGFydCA9IGNvbXBhcmVUby5pbmRleE9mKCdcXFxcUScsIGVzY2FwZUVuZCk7XG4gICAgICAgIH1cbiAgICAgICAgZXhwU3RyaW5nICs9IGNvbXBhcmVUby5zdWJzdHJpbmcoTWF0aC5tYXgoZXNjYXBlU3RhcnQsIGVzY2FwZUVuZCArIDIpKTtcbiAgICAgICAgaWYgKCFzYWZlUmVnZXhUZXN0KGV4cFN0cmluZywgY29uc3RyYWludHMuJG9wdGlvbnMgfHwgJycsIG9iamVjdFtrZXldKSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJyRuZWFyU3BoZXJlJzpcbiAgICAgICAgaWYgKCFjb21wYXJlVG8gfHwgIW9iamVjdFtrZXldKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHZhciBkaXN0YW5jZSA9IGNvbXBhcmVUby5yYWRpYW5zVG8ob2JqZWN0W2tleV0pO1xuICAgICAgICB2YXIgbWF4ID0gY29uc3RyYWludHMuJG1heERpc3RhbmNlIHx8IEluZmluaXR5O1xuICAgICAgICByZXR1cm4gZGlzdGFuY2UgPD0gbWF4O1xuICAgICAgY2FzZSAnJHdpdGhpbic6XG4gICAgICAgIGlmICghY29tcGFyZVRvIHx8ICFvYmplY3Rba2V5XSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgc291dGhXZXN0ID0gY29tcGFyZVRvLiRib3hbMF07XG4gICAgICAgIHZhciBub3J0aEVhc3QgPSBjb21wYXJlVG8uJGJveFsxXTtcbiAgICAgICAgaWYgKHNvdXRoV2VzdC5sYXRpdHVkZSA+IG5vcnRoRWFzdC5sYXRpdHVkZSB8fCBzb3V0aFdlc3QubG9uZ2l0dWRlID4gbm9ydGhFYXN0LmxvbmdpdHVkZSkge1xuICAgICAgICAgIC8vIEludmFsaWQgYm94LCBjcm9zc2VzIHRoZSBkYXRlIGxpbmVcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIChcbiAgICAgICAgICBvYmplY3Rba2V5XS5sYXRpdHVkZSA+IHNvdXRoV2VzdC5sYXRpdHVkZSAmJlxuICAgICAgICAgIG9iamVjdFtrZXldLmxhdGl0dWRlIDwgbm9ydGhFYXN0LmxhdGl0dWRlICYmXG4gICAgICAgICAgb2JqZWN0W2tleV0ubG9uZ2l0dWRlID4gc291dGhXZXN0LmxvbmdpdHVkZSAmJlxuICAgICAgICAgIG9iamVjdFtrZXldLmxvbmdpdHVkZSA8IG5vcnRoRWFzdC5sb25naXR1ZGVcbiAgICAgICAgKTtcbiAgICAgIGNhc2UgJyRjb250YWluZWRCeSc6IHtcbiAgICAgICAgZm9yIChjb25zdCB2YWx1ZSBvZiBvYmplY3Rba2V5XSkge1xuICAgICAgICAgIGlmICghY29udGFpbnMoY29tcGFyZVRvLCB2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBjYXNlICckZ2VvV2l0aGluJzoge1xuICAgICAgICBpZiAoY29tcGFyZVRvLiRwb2x5Z29uKSB7XG4gICAgICAgICAgY29uc3QgcG9pbnRzID0gY29tcGFyZVRvLiRwb2x5Z29uLm1hcChnZW9Qb2ludCA9PiBbXG4gICAgICAgICAgICBnZW9Qb2ludC5sYXRpdHVkZSxcbiAgICAgICAgICAgIGdlb1BvaW50LmxvbmdpdHVkZSxcbiAgICAgICAgICBdKTtcbiAgICAgICAgICBjb25zdCBwb2x5Z29uID0gbmV3IFBhcnNlLlBvbHlnb24ocG9pbnRzKTtcbiAgICAgICAgICByZXR1cm4gcG9seWdvbi5jb250YWluc1BvaW50KG9iamVjdFtrZXldKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29tcGFyZVRvLiRjZW50ZXJTcGhlcmUpIHtcbiAgICAgICAgICBjb25zdCBbV0dTODRQb2ludCwgbWF4RGlzdGFuY2VdID0gY29tcGFyZVRvLiRjZW50ZXJTcGhlcmU7XG4gICAgICAgICAgY29uc3QgY2VudGVyUG9pbnQgPSBuZXcgUGFyc2UuR2VvUG9pbnQoe1xuICAgICAgICAgICAgbGF0aXR1ZGU6IFdHUzg0UG9pbnRbMV0sXG4gICAgICAgICAgICBsb25naXR1ZGU6IFdHUzg0UG9pbnRbMF0sXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgY29uc3QgcG9pbnQgPSBuZXcgUGFyc2UuR2VvUG9pbnQob2JqZWN0W2tleV0pO1xuICAgICAgICAgIGNvbnN0IGRpc3RhbmNlID0gcG9pbnQucmFkaWFuc1RvKGNlbnRlclBvaW50KTtcbiAgICAgICAgICByZXR1cm4gZGlzdGFuY2UgPD0gbWF4RGlzdGFuY2U7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICckZ2VvSW50ZXJzZWN0cyc6IHtcbiAgICAgICAgY29uc3QgcG9seWdvbiA9IG5ldyBQYXJzZS5Qb2x5Z29uKG9iamVjdFtrZXldLmNvb3JkaW5hdGVzKTtcbiAgICAgICAgY29uc3QgcG9pbnQgPSBuZXcgUGFyc2UuR2VvUG9pbnQoY29tcGFyZVRvLiRwb2ludCk7XG4gICAgICAgIHJldHVybiBwb2x5Z29uLmNvbnRhaW5zUG9pbnQocG9pbnQpO1xuICAgICAgfVxuICAgICAgY2FzZSAnJG9wdGlvbnMnOlxuICAgICAgICAvLyBOb3QgYSBxdWVyeSB0eXBlLCBidXQgYSB3YXkgdG8gYWRkIG9wdGlvbnMgdG8gJHJlZ2V4LiBJZ25vcmUgYW5kXG4gICAgICAgIC8vIGF2b2lkIHRoZSBkZWZhdWx0XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnJG1heERpc3RhbmNlJzpcbiAgICAgICAgLy8gTm90IGEgcXVlcnkgdHlwZSwgYnV0IGEgd2F5IHRvIGFkZCBhIGNhcCB0byAkbmVhclNwaGVyZS4gSWdub3JlIGFuZFxuICAgICAgICAvLyBhdm9pZCB0aGUgZGVmYXVsdFxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJyRzZWxlY3QnOlxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICBjYXNlICckZG9udFNlbGVjdCc6XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbnZhciBRdWVyeVRvb2xzID0ge1xuICBxdWVyeUhhc2g6IHF1ZXJ5SGFzaCxcbiAgbWF0Y2hlc1F1ZXJ5OiBtYXRjaGVzUXVlcnksXG4gIHNldFJlZ2V4VGltZW91dDogc2V0UmVnZXhUaW1lb3V0LFxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBRdWVyeVRvb2xzO1xuIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQUlBLFlBQVksR0FBR0MsT0FBTyxDQUFDLGdCQUFnQixDQUFDO0FBQzVDLElBQUlDLEVBQUUsR0FBR0QsT0FBTyxDQUFDLE1BQU0sQ0FBQztBQUN4QixJQUFJRSxLQUFLLEdBQUdGLE9BQU8sQ0FBQyxZQUFZLENBQUM7QUFDakMsSUFBSUcsRUFBRSxHQUFHSCxPQUFPLENBQUMsSUFBSSxDQUFDO0FBQ3RCLElBQUlJLE1BQU0sR0FBR0osT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDSyxPQUFPO0FBRXpDLElBQUlDLFlBQVksR0FBRyxDQUFDO0FBQ3BCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUlDLFNBQVMsR0FBR0osRUFBRSxDQUFDSyxhQUFhLENBQUNDLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3JELElBQUlDLFdBQVcsR0FBRyxJQUFJQyxHQUFHLENBQUMsQ0FBQztBQUMzQixJQUFJQyxnQkFBZ0IsR0FBRyxJQUFJO0FBRTNCLFNBQVNDLGVBQWVBLENBQUNDLEVBQUUsRUFBRTtFQUMzQlQsWUFBWSxHQUFHUyxFQUFFO0FBQ25COztBQUVBO0FBQ0EsU0FBU0MsYUFBYUEsQ0FBQ0MsT0FBTyxFQUFFQyxLQUFLLEVBQUVDLEtBQUssRUFBRTtFQUM1QyxJQUFJO0lBQ0YsSUFBSSxDQUFDYixZQUFZLEVBQUU7TUFDakIsSUFBSWMsRUFBRSxHQUFHLElBQUlDLE1BQU0sQ0FBQ0osT0FBTyxFQUFFQyxLQUFLLENBQUM7TUFDbkMsT0FBT0UsRUFBRSxDQUFDRSxJQUFJLENBQUNILEtBQUssQ0FBQztJQUN2QjtJQUNBLElBQUlJLFFBQVEsR0FBR0wsS0FB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