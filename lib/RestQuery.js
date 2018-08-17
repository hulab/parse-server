'use strict';

// An object that encapsulates everything we need to run a 'find'
// operation, encoded in the REST API format.

var SchemaController = require('./Controllers/SchemaController');
var Parse = require('parse/node').Parse;
const triggers = require('./triggers');

const AlwaysSelectedKeys = ['objectId', 'createdAt', 'updatedAt', 'ACL'];
// restOptions can include:
//   skip
//   limit
//   order
//   count
//   include
//   keys
//   redirectClassNameForKey
function RestQuery(config, auth, className, restWhere = {}, restOptions = {}, clientSDK) {

  this.config = config;
  this.auth = auth;
  this.className = className;
  this.restWhere = restWhere;
  this.restOptions = restOptions;
  this.clientSDK = clientSDK;
  this.response = null;
  this.findOptions = {};
  this.isWrite = false;

  if (!this.auth.isMaster) {
    if (this.className == '_Session') {
      if (!this.auth.user) {
        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
      }
      this.restWhere = {
        '$and': [this.restWhere, {
          'user': {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }

  this.doCount = false;
  this.includeAll = false;

  // The format for this.include is not the same as the format for the
  // include option - it's the paths we should include, in order,
  // stored as arrays, taking into account that we need to include foo
  // before including foo.bar. Also it should dedupe.
  // For example, passing an arg of include=foo.bar,foo.baz could lead to
  // this.include = [['foo'], ['foo', 'baz'], ['foo', 'bar']]
  this.include = [];

  // If we have keys, we probably want to force some includes (n-1 level)
  // See issue: https://github.com/parse-community/parse-server/issues/3185
  if (restOptions.hasOwnProperty('keys')) {
    const keysForInclude = restOptions.keys.split(',').filter(key => {
      // At least 2 components
      return key.split(".").length > 1;
    }).map(key => {
      // Slice the last component (a.b.c -> a.b)
      // Otherwise we'll include one level too much.
      return key.slice(0, key.lastIndexOf("."));
    }).join(',');

    // Concat the possibly present include string with the one from the keys
    // Dedup / sorting is handle in 'include' case.
    if (keysForInclude.length > 0) {
      if (!restOptions.include || restOptions.include.length == 0) {
        restOptions.include = keysForInclude;
      } else {
        restOptions.include += "," + keysForInclude;
      }
    }
  }

  for (var option in restOptions) {
    switch (option) {
      case 'keys':
        {
          const keys = restOptions.keys.split(',').concat(AlwaysSelectedKeys);
          this.keys = Array.from(new Set(keys));
          break;
        }
      case 'count':
        this.doCount = true;
        break;
      case 'includeAll':
        this.includeAll = true;
        break;
      case 'distinct':
      case 'pipeline':
      case 'skip':
      case 'limit':
      case 'readPreference':
        this.findOptions[option] = restOptions[option];
        break;
      case 'order':
        var fields = restOptions.order.split(',');
        this.findOptions.sort = fields.reduce((sortMap, field) => {
          field = field.trim();
          if (field === '$score') {
            sortMap.score = { $meta: 'textScore' };
          } else if (field[0] == '-') {
            sortMap[field.slice(1)] = -1;
          } else {
            sortMap[field] = 1;
          }
          return sortMap;
        }, {});
        break;
      case 'include':
        {
          const paths = restOptions.include.split(',');
          if (paths.includes('*')) {
            this.includeAll = true;
            break;
          }
          // Load the existing includes (from keys)
          const pathSet = paths.reduce((memo, path) => {
            // Split each paths on . (a.b.c -> [a,b,c])
            // reduce to create all paths
            // ([a,b,c] -> {a: true, 'a.b': true, 'a.b.c': true})
            return path.split('.').reduce((memo, path, index, parts) => {
              memo[parts.slice(0, index + 1).join('.')] = true;
              return memo;
            }, memo);
          }, {});

          this.include = Object.keys(pathSet).map(s => {
            return s.split('.');
          }).sort((a, b) => {
            return a.length - b.length; // Sort by number of components
          });
          break;
        }
      case 'redirectClassNameForKey':
        this.redirectKey = restOptions.redirectClassNameForKey;
        this.redirectClassName = null;
        break;
      case 'includeReadPreference':
      case 'subqueryReadPreference':
        break;
      default:
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad option: ' + option);
    }
  }
}

// A convenient method to perform all the steps of processing a query
// in order.
// Returns a promise for the response - an object with optional keys
// 'results' and 'count'.
// TODO: consolidate the replaceX functions
RestQuery.prototype.execute = function (executeOptions) {
  return Promise.resolve().then(() => {
    return this.buildRestWhere();
  }).then(() => {
    return this.handleIncludeAll();
  }).then(() => {
    return this.runFind(executeOptions);
  }).then(() => {
    return this.runCount();
  }).then(() => {
    return this.handleInclude();
  }).then(() => {
    return this.runAfterFindTrigger();
  }).then(() => {
    return this.response;
  });
};

RestQuery.prototype.buildRestWhere = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.redirectClassNameForKey();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.replaceSelect();
  }).then(() => {
    return this.replaceDontSelect();
  }).then(() => {
    return this.replaceInQuery();
  }).then(() => {
    return this.replaceNotInQuery();
  }).then(() => {
    return this.replaceEquality();
  });
};

// Marks the query for a write attempt, so we read the proper ACL (write instead of read)
RestQuery.prototype.forWrite = function () {
  this.isWrite = true;
  return this;
};

// Uses the Auth object to get the list of roles, adds the user id
RestQuery.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
    return Promise.resolve();
  }

  this.findOptions.acl = ['*'];

  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.findOptions.acl = this.findOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
};

// Changes the className if redirectClassNameForKey is set.
// Returns a promise.
RestQuery.prototype.redirectClassNameForKey = function () {
  if (!this.redirectKey) {
    return Promise.resolve();
  }

  // We need to change the class name based on the schema
  return this.config.database.redirectClassNameForKey(this.className, this.redirectKey).then(newClassName => {
    this.className = newClassName;
    this.redirectClassName = newClassName;
  });
};

// Validates this operation against the allowClientClassCreation config.
RestQuery.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
};

function transformInQuery(inQueryObject, className, results) {
  var values = [];
  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }
  delete inQueryObject['$inQuery'];
  if (Array.isArray(inQueryObject['$in'])) {
    inQueryObject['$in'] = inQueryObject['$in'].concat(values);
  } else {
    inQueryObject['$in'] = values;
  }
}

// Replaces a $inQuery clause by running the subquery, if there is an
// $inQuery clause.
// The $inQuery clause turns into an $in with values that are just
// pointers to the objects returned in the subquery.
RestQuery.prototype.replaceInQuery = function () {
  var inQueryObject = findObjectWithKey(this.restWhere, '$inQuery');
  if (!inQueryObject) {
    return;
  }

  // The inQuery value must have precisely two keys - where and className
  var inQueryValue = inQueryObject['$inQuery'];
  if (!inQueryValue.where || !inQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $inQuery');
  }

  const additionalOptions = {
    redirectClassNameForKey: inQueryValue.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, inQueryValue.className, inQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformInQuery(inQueryObject, subquery.className, response.results);
    // Recurse to repeat
    return this.replaceInQuery();
  });
};

function transformNotInQuery(notInQueryObject, className, results) {
  var values = [];
  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }
  delete notInQueryObject['$notInQuery'];
  if (Array.isArray(notInQueryObject['$nin'])) {
    notInQueryObject['$nin'] = notInQueryObject['$nin'].concat(values);
  } else {
    notInQueryObject['$nin'] = values;
  }
}

// Replaces a $notInQuery clause by running the subquery, if there is an
// $notInQuery clause.
// The $notInQuery clause turns into a $nin with values that are just
// pointers to the objects returned in the subquery.
RestQuery.prototype.replaceNotInQuery = function () {
  var notInQueryObject = findObjectWithKey(this.restWhere, '$notInQuery');
  if (!notInQueryObject) {
    return;
  }

  // The notInQuery value must have precisely two keys - where and className
  var notInQueryValue = notInQueryObject['$notInQuery'];
  if (!notInQueryValue.where || !notInQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $notInQuery');
  }

  const additionalOptions = {
    redirectClassNameForKey: notInQueryValue.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, notInQueryValue.className, notInQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformNotInQuery(notInQueryObject, subquery.className, response.results);
    // Recurse to repeat
    return this.replaceNotInQuery();
  });
};

const transformSelect = (selectObject, key, objects) => {
  var values = [];
  for (var result of objects) {
    values.push(key.split('.').reduce((o, i) => o[i], result));
  }
  delete selectObject['$select'];
  if (Array.isArray(selectObject['$in'])) {
    selectObject['$in'] = selectObject['$in'].concat(values);
  } else {
    selectObject['$in'] = values;
  }
};

// Replaces a $select clause by running the subquery, if there is a
// $select clause.
// The $select clause turns into an $in with values selected out of
// the subquery.
// Returns a possible-promise.
RestQuery.prototype.replaceSelect = function () {
  var selectObject = findObjectWithKey(this.restWhere, '$select');
  if (!selectObject) {
    return;
  }

  // The select value must have precisely two keys - query and key
  var selectValue = selectObject['$select'];
  // iOS SDK don't send where if not set, let it pass
  if (!selectValue.query || !selectValue.key || typeof selectValue.query !== 'object' || !selectValue.query.className || Object.keys(selectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $select');
  }

  const additionalOptions = {
    redirectClassNameForKey: selectValue.query.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, selectValue.query.className, selectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformSelect(selectObject, selectValue.key, response.results);
    // Keep replacing $select clauses
    return this.replaceSelect();
  });
};

const transformDontSelect = (dontSelectObject, key, objects) => {
  var values = [];
  for (var result of objects) {
    values.push(key.split('.').reduce((o, i) => o[i], result));
  }
  delete dontSelectObject['$dontSelect'];
  if (Array.isArray(dontSelectObject['$nin'])) {
    dontSelectObject['$nin'] = dontSelectObject['$nin'].concat(values);
  } else {
    dontSelectObject['$nin'] = values;
  }
};

// Replaces a $dontSelect clause by running the subquery, if there is a
// $dontSelect clause.
// The $dontSelect clause turns into an $nin with values selected out of
// the subquery.
// Returns a possible-promise.
RestQuery.prototype.replaceDontSelect = function () {
  var dontSelectObject = findObjectWithKey(this.restWhere, '$dontSelect');
  if (!dontSelectObject) {
    return;
  }

  // The dontSelect value must have precisely two keys - query and key
  var dontSelectValue = dontSelectObject['$dontSelect'];
  if (!dontSelectValue.query || !dontSelectValue.key || typeof dontSelectValue.query !== 'object' || !dontSelectValue.query.className || Object.keys(dontSelectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $dontSelect');
  }
  const additionalOptions = {
    redirectClassNameForKey: dontSelectValue.query.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, dontSelectValue.query.className, dontSelectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformDontSelect(dontSelectObject, dontSelectValue.key, response.results);
    // Keep replacing $dontSelect clauses
    return this.replaceDontSelect();
  });
};

const cleanResultOfSensitiveUserInfo = function (result, auth, config) {
  delete result.password;

  if (auth.isMaster || auth.user && auth.user.id === result.objectId) {
    return;
  }

  for (const field of config.userSensitiveFields) {
    delete result[field];
  }
};

const cleanResultAuthData = function (result) {
  if (result.authData) {
    Object.keys(result.authData).forEach(provider => {
      if (result.authData[provider] === null) {
        delete result.authData[provider];
      }
    });

    if (Object.keys(result.authData).length == 0) {
      delete result.authData;
    }
  }
};

const replaceEqualityConstraint = constraint => {
  if (typeof constraint !== 'object') {
    return constraint;
  }
  const equalToObject = {};
  let hasDirectConstraint = false;
  let hasOperatorConstraint = false;
  for (const key in constraint) {
    if (key.indexOf('$') !== 0) {
      hasDirectConstraint = true;
      equalToObject[key] = constraint[key];
    } else {
      hasOperatorConstraint = true;
    }
  }
  if (hasDirectConstraint && hasOperatorConstraint) {
    constraint['$eq'] = equalToObject;
    Object.keys(equalToObject).forEach(key => {
      delete constraint[key];
    });
  }
  return constraint;
};

RestQuery.prototype.replaceEquality = function () {
  if (typeof this.restWhere !== 'object') {
    return;
  }
  for (const key in this.restWhere) {
    this.restWhere[key] = replaceEqualityConstraint(this.restWhere[key]);
  }
};

// Returns a promise for whether it was successful.
// Populates this.response with an object that only has 'results'.
RestQuery.prototype.runFind = function (options = {}) {
  if (this.findOptions.limit === 0) {
    this.response = { results: [] };
    return Promise.resolve();
  }
  const findOptions = Object.assign({}, this.findOptions);
  if (this.keys) {
    findOptions.keys = this.keys.map(key => {
      return key.split('.')[0];
    });
  }
  if (options.op) {
    findOptions.op = options.op;
  }
  if (this.isWrite) {
    findOptions.isWrite = true;
  }
  return this.config.database.find(this.className, this.restWhere, findOptions).then(results => {
    if (this.className === '_User') {
      for (var result of results) {
        cleanResultOfSensitiveUserInfo(result, this.auth, this.config);
        cleanResultAuthData(result);
      }
    }

    this.config.filesController.expandFilesInObject(this.config, results);

    if (this.redirectClassName) {
      for (var r of results) {
        r.className = this.redirectClassName;
      }
    }
    this.response = { results: results };
  });
};

// Returns a promise for whether it was successful.
// Populates this.response.count with the count
RestQuery.prototype.runCount = function () {
  if (!this.doCount) {
    return;
  }
  this.findOptions.count = true;
  delete this.findOptions.skip;
  delete this.findOptions.limit;
  return this.config.database.find(this.className, this.restWhere, this.findOptions).then(c => {
    this.response.count = c;
  });
};

// Augments this.response with all pointers on an object
RestQuery.prototype.handleIncludeAll = function () {
  if (!this.includeAll) {
    return;
  }
  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const includeFields = [];
    const keyFields = [];
    for (const field in schema.fields) {
      if (schema.fields[field].type && schema.fields[field].type === 'Pointer') {
        includeFields.push([field]);
        keyFields.push(field);
      }
    }
    // Add fields to include, keys, remove dups
    this.include = [...new Set([...this.include, ...includeFields])];
    // if this.keys not set, then all keys are already included
    if (this.keys) {
      this.keys = [...new Set([...this.keys, ...keyFields])];
    }
  });
};

// Augments this.response with data at the paths provided in this.include.
RestQuery.prototype.handleInclude = function () {
  if (this.include.length == 0) {
    return;
  }

  var pathResponse = includePath(this.config, this.auth, this.response, this.include[0], this.restOptions);
  if (pathResponse.then) {
    return pathResponse.then(newResponse => {
      this.response = newResponse;
      this.include = this.include.slice(1);
      return this.handleInclude();
    });
  } else if (this.include.length > 0) {
    this.include = this.include.slice(1);
    return this.handleInclude();
  }

  return pathResponse;
};

//Returns a promise of a processed set of results
RestQuery.prototype.runAfterFindTrigger = function () {
  if (!this.response) {
    return;
  }
  // Avoid doing any setup for triggers if there is no 'afterFind' trigger for this class.
  const hasAfterFindHook = triggers.triggerExists(this.className, triggers.Types.afterFind, this.config.applicationId);
  if (!hasAfterFindHook) {
    return Promise.resolve();
  }
  // Skip Aggregate and Distinct Queries
  if (this.findOptions.pipeline || this.findOptions.distinct) {
    return Promise.resolve();
  }
  // Run afterFind trigger and set the new results
  return triggers.maybeRunAfterFindTrigger(triggers.Types.afterFind, this.auth, this.className, this.response.results, this.config).then(results => {
    // Ensure we properly set the className back
    if (this.redirectClassName) {
      this.response.results = results.map(object => {
        if (object instanceof Parse.Object) {
          object = object.toJSON();
        }
        object.className = this.redirectClassName;
        return object;
      });
    } else {
      this.response.results = results;
    }
  });
};

// Adds included values to the response.
// Path is a list of field names.
// Returns a promise for an augmented response.
function includePath(config, auth, response, path, restOptions = {}) {
  var pointers = findPointers(response.results, path);
  if (pointers.length == 0) {
    return response;
  }
  const pointersHash = {};
  for (var pointer of pointers) {
    if (!pointer) {
      continue;
    }
    const className = pointer.className;
    // only include the good pointers
    if (className) {
      pointersHash[className] = pointersHash[className] || new Set();
      pointersHash[className].add(pointer.objectId);
    }
  }
  const includeRestOptions = {};
  if (restOptions.keys) {
    const keys = new Set(restOptions.keys.split(','));
    const keySet = Array.from(keys).reduce((set, key) => {
      const keyPath = key.split('.');
      let i = 0;
      for (i; i < path.length; i++) {
        if (path[i] != keyPath[i]) {
          return set;
        }
      }
      if (i < keyPath.length) {
        set.add(keyPath[i]);
      }
      return set;
    }, new Set());
    if (keySet.size > 0) {
      includeRestOptions.keys = Array.from(keySet).join(',');
    }
  }

  if (restOptions.includeReadPreference) {
    includeRestOptions.readPreference = restOptions.includeReadPreference;
    includeRestOptions.includeReadPreference = restOptions.includeReadPreference;
  }

  const queryPromises = Object.keys(pointersHash).map(className => {
    const objectIds = Array.from(pointersHash[className]);
    let where;
    if (objectIds.length === 1) {
      where = { 'objectId': objectIds[0] };
    } else {
      where = { 'objectId': { '$in': objectIds } };
    }
    var query = new RestQuery(config, auth, className, where, includeRestOptions);
    return query.execute({ op: 'get' }).then(results => {
      results.className = className;
      return Promise.resolve(results);
    });
  });

  // Get the objects for all these object ids
  return Promise.all(queryPromises).then(responses => {
    var replace = responses.reduce((replace, includeResponse) => {
      for (var obj of includeResponse.results) {
        obj.__type = 'Object';
        obj.className = includeResponse.className;

        if (obj.className == "_User" && !auth.isMaster) {
          delete obj.sessionToken;
          delete obj.authData;
        }
        replace[obj.objectId] = obj;
      }
      return replace;
    }, {});

    var resp = {
      results: replacePointers(response.results, path, replace)
    };
    if (response.count) {
      resp.count = response.count;
    }
    return resp;
  });
}

// Object may be a list of REST-format object to find pointers in, or
// it may be a single object.
// If the path yields things that aren't pointers, this throws an error.
// Path is a list of fields to search into.
// Returns a list of pointers in REST format.
function findPointers(object, path) {
  if (object instanceof Array) {
    var answer = [];
    for (var x of object) {
      answer = answer.concat(findPointers(x, path));
    }
    return answer;
  }

  if (typeof object !== 'object' || !object) {
    return [];
  }

  if (path.length == 0) {
    if (object === null || object.__type == 'Pointer') {
      return [object];
    }
    return [];
  }

  var subobject = object[path[0]];
  if (!subobject) {
    return [];
  }
  return findPointers(subobject, path.slice(1));
}

// Object may be a list of REST-format objects to replace pointers
// in, or it may be a single object.
// Path is a list of fields to search into.
// replace is a map from object id -> object.
// Returns something analogous to object, but with the appropriate
// pointers inflated.
function replacePointers(object, path, replace) {
  if (object instanceof Array) {
    return object.map(obj => replacePointers(obj, path, replace)).filter(obj => typeof obj !== 'undefined');
  }

  if (typeof object !== 'object' || !object) {
    return object;
  }

  if (path.length === 0) {
    if (object && object.__type === 'Pointer') {
      return replace[object.objectId];
    }
    return object;
  }

  var subobject = object[path[0]];
  if (!subobject) {
    return object;
  }
  var newsub = replacePointers(subobject, path.slice(1), replace);
  var answer = {};
  for (var key in object) {
    if (key == path[0]) {
      answer[key] = newsub;
    } else {
      answer[key] = object[key];
    }
  }
  return answer;
}

// Finds a subobject that has the given key, if there is one.
// Returns undefined otherwise.
function findObjectWithKey(root, key) {
  if (typeof root !== 'object') {
    return;
  }
  if (root instanceof Array) {
    for (var item of root) {
      const answer = findObjectWithKey(item, key);
      if (answer) {
        return answer;
      }
    }
  }
  if (root && root[key]) {
    return root;
  }
  for (var subkey in root) {
    const answer = findObjectWithKey(root[subkey], key);
    if (answer) {
      return answer;
    }
  }
}

module.exports = RestQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0UXVlcnkuanMiXSwibmFtZXMiOlsiU2NoZW1hQ29udHJvbGxlciIsInJlcXVpcmUiLCJQYXJzZSIsInRyaWdnZXJzIiwiQWx3YXlzU2VsZWN0ZWRLZXlzIiwiUmVzdFF1ZXJ5IiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInJlc3RXaGVyZSIsInJlc3RPcHRpb25zIiwiY2xpZW50U0RLIiwicmVzcG9uc2UiLCJmaW5kT3B0aW9ucyIsImlzV3JpdGUiLCJpc01hc3RlciIsInVzZXIiLCJFcnJvciIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIl9fdHlwZSIsIm9iamVjdElkIiwiaWQiLCJkb0NvdW50IiwiaW5jbHVkZUFsbCIsImluY2x1ZGUiLCJoYXNPd25Qcm9wZXJ0eSIsImtleXNGb3JJbmNsdWRlIiwia2V5cyIsInNwbGl0IiwiZmlsdGVyIiwia2V5IiwibGVuZ3RoIiwibWFwIiwic2xpY2UiLCJsYXN0SW5kZXhPZiIsImpvaW4iLCJvcHRpb24iLCJjb25jYXQiLCJBcnJheSIsImZyb20iLCJTZXQiLCJmaWVsZHMiLCJvcmRlciIsInNvcnQiLCJyZWR1Y2UiLCJzb3J0TWFwIiwiZmllbGQiLCJ0cmltIiwic2NvcmUiLCIkbWV0YSIsInBhdGhzIiwiaW5jbHVkZXMiLCJwYXRoU2V0IiwibWVtbyIsInBhdGgiLCJpbmRleCIsInBhcnRzIiwiT2JqZWN0IiwicyIsImEiLCJiIiwicmVkaXJlY3RLZXkiLCJyZWRpcmVjdENsYXNzTmFtZUZvcktleSIsInJlZGlyZWN0Q2xhc3NOYW1lIiwiSU5WQUxJRF9KU09OIiwicHJvdG90eXBlIiwiZXhlY3V0ZSIsImV4ZWN1dGVPcHRpb25zIiwiUHJvbWlzZSIsInJlc29sdmUiLCJ0aGVuIiwiYnVpbGRSZXN0V2hlcmUiLCJoYW5kbGVJbmNsdWRlQWxsIiwicnVuRmluZCIsInJ1bkNvdW50IiwiaGFuZGxlSW5jbHVkZSIsInJ1bkFmdGVyRmluZFRyaWdnZXIiLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsInJlcGxhY2VTZWxlY3QiLCJyZXBsYWNlRG9udFNlbGVjdCIsInJlcGxhY2VJblF1ZXJ5IiwicmVwbGFjZU5vdEluUXVlcnkiLCJyZXBsYWNlRXF1YWxpdHkiLCJmb3JXcml0ZSIsImFjbCIsImdldFVzZXJSb2xlcyIsInJvbGVzIiwiZGF0YWJhc2UiLCJuZXdDbGFzc05hbWUiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImxvYWRTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwiaGFzQ2xhc3MiLCJPUEVSQVRJT05fRk9SQklEREVOIiwidHJhbnNmb3JtSW5RdWVyeSIsImluUXVlcnlPYmplY3QiLCJyZXN1bHRzIiwidmFsdWVzIiwicmVzdWx0IiwicHVzaCIsImlzQXJyYXkiLCJmaW5kT2JqZWN0V2l0aEtleSIsImluUXVlcnlWYWx1ZSIsIndoZXJlIiwiSU5WQUxJRF9RVUVSWSIsImFkZGl0aW9uYWxPcHRpb25zIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsInJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnkiLCJ0cmFuc2Zvcm1Ob3RJblF1ZXJ5Iiwibm90SW5RdWVyeU9iamVjdCIsIm5vdEluUXVlcnlWYWx1ZSIsInRyYW5zZm9ybVNlbGVjdCIsInNlbGVjdE9iamVjdCIsIm9iamVjdHMiLCJvIiwiaSIsInNlbGVjdFZhbHVlIiwicXVlcnkiLCJ0cmFuc2Zvcm1Eb250U2VsZWN0IiwiZG9udFNlbGVjdE9iamVjdCIsImRvbnRTZWxlY3RWYWx1ZSIsImNsZWFuUmVzdWx0T2ZTZW5zaXRpdmVVc2VySW5mbyIsInBhc3N3b3JkIiwidXNlclNlbnNpdGl2ZUZpZWxkcyIsImNsZWFuUmVzdWx0QXV0aERhdGEiLCJhdXRoRGF0YSIsImZvckVhY2giLCJwcm92aWRlciIsInJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQiLCJjb25zdHJhaW50IiwiZXF1YWxUb09iamVjdCIsImhhc0RpcmVjdENvbnN0cmFpbnQiLCJoYXNPcGVyYXRvckNvbnN0cmFpbnQiLCJvcHRpb25zIiwibGltaXQiLCJhc3NpZ24iLCJvcCIsImZpbmQiLCJmaWxlc0NvbnRyb2xsZXIiLCJleHBhbmRGaWxlc0luT2JqZWN0IiwiciIsImNvdW50Iiwic2tpcCIsImMiLCJnZXRPbmVTY2hlbWEiLCJzY2hlbWEiLCJpbmNsdWRlRmllbGRzIiwia2V5RmllbGRzIiwidHlwZSIsInBhdGhSZXNwb25zZSIsImluY2x1ZGVQYXRoIiwibmV3UmVzcG9uc2UiLCJoYXNBZnRlckZpbmRIb29rIiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYWZ0ZXJGaW5kIiwiYXBwbGljYXRpb25JZCIsInBpcGVsaW5lIiwiZGlzdGluY3QiLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJvYmplY3QiLCJ0b0pTT04iLCJwb2ludGVycyIsImZpbmRQb2ludGVycyIsInBvaW50ZXJzSGFzaCIsInBvaW50ZXIiLCJhZGQiLCJpbmNsdWRlUmVzdE9wdGlvbnMiLCJrZXlTZXQiLCJzZXQiLCJrZXlQYXRoIiwic2l6ZSIsImluY2x1ZGVSZWFkUHJlZmVyZW5jZSIsInF1ZXJ5UHJvbWlzZXMiLCJvYmplY3RJZHMiLCJhbGwiLCJyZXNwb25zZXMiLCJyZXBsYWNlIiwiaW5jbHVkZVJlc3BvbnNlIiwib2JqIiwic2Vzc2lvblRva2VuIiwicmVzcCIsInJlcGxhY2VQb2ludGVycyIsImFuc3dlciIsIngiLCJzdWJvYmplY3QiLCJuZXdzdWIiLCJyb290IiwiaXRlbSIsInN1YmtleSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUE7QUFDQTs7QUFFQSxJQUFJQSxtQkFBbUJDLFFBQVEsZ0NBQVIsQ0FBdkI7QUFDQSxJQUFJQyxRQUFRRCxRQUFRLFlBQVIsRUFBc0JDLEtBQWxDO0FBQ0EsTUFBTUMsV0FBV0YsUUFBUSxZQUFSLENBQWpCOztBQUVBLE1BQU1HLHFCQUFxQixDQUFDLFVBQUQsRUFBYSxXQUFiLEVBQTBCLFdBQTFCLEVBQXVDLEtB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QUFaLEVBQXVCO0FBQ3JCLFdBQU9pSyxJQUFQO0FBQ0Q7QUFDRCxPQUFLLElBQUlFLE1BQVQsSUFBbUJGLElBQW5CLEVBQXlCO0FBQ3ZCLFVBQU1KLFNBQVNuRixrQkFBa0J1RixLQUFLRSxNQUFMLENBQWxCLEVBQWdDbkssR0FBaEMsQ0FBZjtBQUNBLFFBQUk2SixNQUFKLEVBQVk7QUFDVixhQUFPQSxNQUFQO0FBQ0Q7QUFDRjtBQUNGOztBQUVETyxPQUFPQyxPQUFQLEdBQWlCOUwsU0FBakIiLCJmaWxlIjoiUmVzdFF1ZXJ5LmpzIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQW4gb2JqZWN0IHRoYXQgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYSAnZmluZCdcbi8vIG9wZXJhdGlvbiwgZW5jb2RlZCBpbiB0aGUgUkVTVCBBUEkgZm9ybWF0LlxuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlO1xuY29uc3QgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG5cbmNvbnN0IEFsd2F5c1NlbGVjdGVkS2V5cyA9IFsnb2JqZWN0SWQnLCAnY3JlYXRlZEF0JywgJ3VwZGF0ZWRBdCcsICdBQ0wnXTtcbi8vIHJlc3RPcHRpb25zIGNhbiBpbmNsdWRlOlxuLy8gICBza2lwXG4vLyAgIGxpbWl0XG4vLyAgIG9yZGVyXG4vLyAgIGNvdW50XG4vLyAgIGluY2x1ZGVcbi8vICAga2V5c1xuLy8gICByZWRpcmVjdENsYXNzTmFtZUZvcktleVxuZnVuY3Rpb24gUmVzdFF1ZXJ5KGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCByZXN0V2hlcmUgPSB7fSwgcmVzdE9wdGlvbnMgPSB7fSwgY2xpZW50U0RLKSB7XG5cbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLnJlc3RXaGVyZSA9IHJlc3RXaGVyZTtcbiAgdGhpcy5yZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zO1xuICB0aGlzLmNsaWVudFNESyA9IGNsaWVudFNESztcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG4gIHRoaXMuZmluZE9wdGlvbnMgPSB7fTtcbiAgdGhpcy5pc1dyaXRlID0gZmFsc2U7XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICBpZiAodGhpcy5jbGFzc05hbWUgPT0gJ19TZXNzaW9uJykge1xuICAgICAgaWYgKCF0aGlzLmF1dGgudXNlcikge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLFxuICAgICAgICAgICdJbnZhbGlkIHNlc3Npb24gdG9rZW4nKTtcbiAgICAgIH1cbiAgICAgIHRoaXMucmVzdFdoZXJlID0ge1xuICAgICAgICAnJGFuZCc6IFt0aGlzLnJlc3RXaGVyZSwge1xuICAgICAgICAgICd1c2VyJzoge1xuICAgICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWRcbiAgICAgICAgICB9XG4gICAgICAgIH1dXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHRoaXMuZG9Db3VudCA9IGZhbHNlO1xuICB0aGlzLmluY2x1ZGVBbGwgPSBmYWxzZTtcblxuICAvLyBUaGUgZm9ybWF0IGZvciB0aGlzLmluY2x1ZGUgaXMgbm90IHRoZSBzYW1lIGFzIHRoZSBmb3JtYXQgZm9yIHRoZVxuICAvLyBpbmNsdWRlIG9wdGlvbiAtIGl0J3MgdGhlIHBhdGhzIHdlIHNob3VsZCBpbmNsdWRlLCBpbiBvcmRlcixcbiAgLy8gc3RvcmVkIGFzIGFycmF5cywgdGFraW5nIGludG8gYWNjb3VudCB0aGF0IHdlIG5lZWQgdG8gaW5jbHVkZSBmb29cbiAgLy8gYmVmb3JlIGluY2x1ZGluZyBmb28uYmFyLiBBbHNvIGl0IHNob3VsZCBkZWR1cGUuXG4gIC8vIEZvciBleGFtcGxlLCBwYXNzaW5nIGFuIGFyZyBvZiBpbmNsdWRlPWZvby5iYXIsZm9vLmJheiBjb3VsZCBsZWFkIHRvXG4gIC8vIHRoaXMuaW5jbHVkZSA9IFtbJ2ZvbyddLCBbJ2ZvbycsICdiYXonXSwgWydmb28nLCAnYmFyJ11dXG4gIHRoaXMuaW5jbHVkZSA9IFtdO1xuXG4gIC8vIElmIHdlIGhhdmUga2V5cywgd2UgcHJvYmFibHkgd2FudCB0byBmb3JjZSBzb21lIGluY2x1ZGVzIChuLTEgbGV2ZWwpXG4gIC8vIFNlZSBpc3N1ZTogaHR0cHM6Ly9naXRodWIuY29tL3BhcnNlLWNvbW11bml0eS9wYXJzZS1zZXJ2ZXIvaXNzdWVzLzMxODVcbiAgaWYgKHJlc3RPcHRpb25zLmhhc093blByb3BlcnR5KCdrZXlzJykpIHtcbiAgICBjb25zdCBrZXlzRm9ySW5jbHVkZSA9IHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKS5maWx0ZXIoKGtleSkgPT4ge1xuICAgICAgLy8gQXQgbGVhc3QgMiBjb21wb25lbnRzXG4gICAgICByZXR1cm4ga2V5LnNwbGl0KFwiLlwiKS5sZW5ndGggPiAxO1xuICAgIH0pLm1hcCgoa2V5KSA9PiB7XG4gICAgICAvLyBTbGljZSB0aGUgbGFzdCBjb21wb25lbnQgKGEuYi5jIC0+IGEuYilcbiAgICAgIC8vIE90aGVyd2lzZSB3ZSdsbCBpbmNsdWRlIG9uZSBsZXZlbCB0b28gbXVjaC5cbiAgICAgIHJldHVybiBrZXkuc2xpY2UoMCwga2V5Lmxhc3RJbmRleE9mKFwiLlwiKSk7XG4gICAgfSkuam9pbignLCcpO1xuXG4gICAgLy8gQ29uY2F0IHRoZSBwb3NzaWJseSBwcmVzZW50IGluY2x1ZGUgc3RyaW5nIHdpdGggdGhlIG9uZSBmcm9tIHRoZSBrZXlzXG4gICAgLy8gRGVkdXAgLyBzb3J0aW5nIGlzIGhhbmRsZSBpbiAnaW5jbHVkZScgY2FzZS5cbiAgICBpZiAoa2V5c0ZvckluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgICAgaWYgKCFyZXN0T3B0aW9ucy5pbmNsdWRlIHx8IHJlc3RPcHRpb25zLmluY2x1ZGUubGVuZ3RoID09IDApIHtcbiAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSA9IGtleXNGb3JJbmNsdWRlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSArPSBcIixcIiArIGtleXNGb3JJbmNsdWRlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZvciAodmFyIG9wdGlvbiBpbiByZXN0T3B0aW9ucykge1xuICAgIHN3aXRjaChvcHRpb24pIHtcbiAgICBjYXNlICdrZXlzJzoge1xuICAgICAgY29uc3Qga2V5cyA9IHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKS5jb25jYXQoQWx3YXlzU2VsZWN0ZWRLZXlzKTtcbiAgICAgIHRoaXMua2V5cyA9IEFycmF5LmZyb20obmV3IFNldChrZXlzKSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSAnY291bnQnOlxuICAgICAgdGhpcy5kb0NvdW50ID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ2luY2x1ZGVBbGwnOlxuICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ2Rpc3RpbmN0JzpcbiAgICBjYXNlICdwaXBlbGluZSc6XG4gICAgY2FzZSAnc2tpcCc6XG4gICAgY2FzZSAnbGltaXQnOlxuICAgIGNhc2UgJ3JlYWRQcmVmZXJlbmNlJzpcbiAgICAgIHRoaXMuZmluZE9wdGlvbnNbb3B0aW9uXSA9IHJlc3RPcHRpb25zW29wdGlvbl07XG4gICAgICBicmVhaztcbiAgICBjYXNlICdvcmRlcic6XG4gICAgICB2YXIgZmllbGRzID0gcmVzdE9wdGlvbnMub3JkZXIuc3BsaXQoJywnKTtcbiAgICAgIHRoaXMuZmluZE9wdGlvbnMuc29ydCA9IGZpZWxkcy5yZWR1Y2UoKHNvcnRNYXAsIGZpZWxkKSA9PiB7XG4gICAgICAgIGZpZWxkID0gZmllbGQudHJpbSgpO1xuICAgICAgICBpZiAoZmllbGQgPT09ICckc2NvcmUnKSB7XG4gICAgICAgICAgc29ydE1hcC5zY29yZSA9IHskbWV0YTogJ3RleHRTY29yZSd9O1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkWzBdID09ICctJykge1xuICAgICAgICAgIHNvcnRNYXBbZmllbGQuc2xpY2UoMSldID0gLTE7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc29ydE1hcFtmaWVsZF0gPSAxO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBzb3J0TWFwO1xuICAgICAgfSwge30pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnaW5jbHVkZSc6IHtcbiAgICAgIGNvbnN0IHBhdGhzID0gcmVzdE9wdGlvbnMuaW5jbHVkZS5zcGxpdCgnLCcpO1xuICAgICAgaWYgKHBhdGhzLmluY2x1ZGVzKCcqJykpIHtcbiAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICAvLyBMb2FkIHRoZSBleGlzdGluZyBpbmNsdWRlcyAoZnJvbSBrZXlzKVxuICAgICAgY29uc3QgcGF0aFNldCA9IHBhdGhzLnJlZHVjZSgobWVtbywgcGF0aCkgPT4ge1xuICAgICAgICAvLyBTcGxpdCBlYWNoIHBhdGhzIG9uIC4gKGEuYi5jIC0+IFthLGIsY10pXG4gICAgICAgIC8vIHJlZHVjZSB0byBjcmVhdGUgYWxsIHBhdGhzXG4gICAgICAgIC8vIChbYSxiLGNdIC0+IHthOiB0cnVlLCAnYS5iJzogdHJ1ZSwgJ2EuYi5jJzogdHJ1ZX0pXG4gICAgICAgIHJldHVybiBwYXRoLnNwbGl0KCcuJykucmVkdWNlKChtZW1vLCBwYXRoLCBpbmRleCwgcGFydHMpID0+IHtcbiAgICAgICAgICBtZW1vW3BhcnRzLnNsaWNlKDAsIGluZGV4ICsgMSkuam9pbignLicpXSA9IHRydWU7XG4gICAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICAgIH0sIG1lbW8pO1xuICAgICAgfSwge30pO1xuXG4gICAgICB0aGlzLmluY2x1ZGUgPSBPYmplY3Qua2V5cyhwYXRoU2V0KS5tYXAoKHMpID0+IHtcbiAgICAgICAgcmV0dXJuIHMuc3BsaXQoJy4nKTtcbiAgICAgIH0pLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7IC8vIFNvcnQgYnkgbnVtYmVyIG9mIGNvbXBvbmVudHNcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgJ3JlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5JzpcbiAgICAgIHRoaXMucmVkaXJlY3RLZXkgPSByZXN0T3B0aW9ucy5yZWRpcmVjdENsYXNzTmFtZUZvcktleTtcbiAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWUgPSBudWxsO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnaW5jbHVkZVJlYWRQcmVmZXJlbmNlJzpcbiAgICBjYXNlICdzdWJxdWVyeVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAnYmFkIG9wdGlvbjogJyArIG9wdGlvbik7XG4gICAgfVxuICB9XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgYSBxdWVyeVxuLy8gaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgdGhlIHJlc3BvbnNlIC0gYW4gb2JqZWN0IHdpdGggb3B0aW9uYWwga2V5c1xuLy8gJ3Jlc3VsdHMnIGFuZCAnY291bnQnLlxuLy8gVE9ETzogY29uc29saWRhdGUgdGhlIHJlcGxhY2VYIGZ1bmN0aW9uc1xuUmVzdFF1ZXJ5LnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24oZXhlY3V0ZU9wdGlvbnMpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmJ1aWxkUmVzdFdoZXJlKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGVBbGwoKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMucnVuRmluZChleGVjdXRlT3B0aW9ucyk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLnJ1bkNvdW50KCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGUoKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMucnVuQWZ0ZXJGaW5kVHJpZ2dlcigpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgfSk7XG59O1xuXG5SZXN0UXVlcnkucHJvdG90eXBlLmJ1aWxkUmVzdFdoZXJlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5yZWRpcmVjdENsYXNzTmFtZUZvcktleSgpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZVNlbGVjdCgpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlRG9udFNlbGVjdCgpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlSW5RdWVyeSgpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlRXF1YWxpdHkoKTtcbiAgfSk7XG59XG5cbi8vIE1hcmtzIHRoZSBxdWVyeSBmb3IgYSB3cml0ZSBhdHRlbXB0LCBzbyB3ZSByZWFkIHRoZSBwcm9wZXIgQUNMICh3cml0ZSBpbnN0ZWFkIG9mIHJlYWQpXG5SZXN0UXVlcnkucHJvdG90eXBlLmZvcldyaXRlID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMuaXNXcml0ZSA9IHRydWU7XG4gIHJldHVybiB0aGlzO1xufVxuXG4vLyBVc2VzIHRoZSBBdXRoIG9iamVjdCB0byBnZXQgdGhlIGxpc3Qgb2Ygcm9sZXMsIGFkZHMgdGhlIHVzZXIgaWRcblJlc3RRdWVyeS5wcm90b3R5cGUuZ2V0VXNlckFuZFJvbGVBQ0wgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMuZmluZE9wdGlvbnMuYWNsID0gWycqJ107XG5cbiAgaWYgKHRoaXMuYXV0aC51c2VyKSB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC5nZXRVc2VyUm9sZXMoKS50aGVuKChyb2xlcykgPT4ge1xuICAgICAgdGhpcy5maW5kT3B0aW9ucy5hY2wgPSB0aGlzLmZpbmRPcHRpb25zLmFjbC5jb25jYXQocm9sZXMsIFt0aGlzLmF1dGgudXNlci5pZF0pO1xuICAgICAgcmV0dXJuO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gQ2hhbmdlcyB0aGUgY2xhc3NOYW1lIGlmIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IGlzIHNldC5cbi8vIFJldHVybnMgYSBwcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMucmVkaXJlY3RLZXkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBXZSBuZWVkIHRvIGNoYW5nZSB0aGUgY2xhc3MgbmFtZSBiYXNlZCBvbiB0aGUgc2NoZW1hXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZWRpcmVjdEtleSlcbiAgICAudGhlbigobmV3Q2xhc3NOYW1lKSA9PiB7XG4gICAgICB0aGlzLmNsYXNzTmFtZSA9IG5ld0NsYXNzTmFtZTtcbiAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWUgPSBuZXdDbGFzc05hbWU7XG4gICAgfSk7XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIGNvbmZpZy5cblJlc3RRdWVyeS5wcm90b3R5cGUudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmICF0aGlzLmF1dGguaXNNYXN0ZXJcbiAgICAgICYmIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTEpIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgICdUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gYWNjZXNzICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnbm9uLWV4aXN0ZW50IGNsYXNzOiAnICsgdGhpcy5jbGFzc05hbWUpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybUluUXVlcnkoaW5RdWVyeU9iamVjdCwgY2xhc3NOYW1lLCByZXN1bHRzKSB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICB2YWx1ZXMucHVzaCh7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IHJlc3VsdC5vYmplY3RJZFxuICAgIH0pO1xuICB9XG4gIGRlbGV0ZSBpblF1ZXJ5T2JqZWN0WyckaW5RdWVyeSddO1xuICBpZiAoQXJyYXkuaXNBcnJheShpblF1ZXJ5T2JqZWN0WyckaW4nXSkpIHtcbiAgICBpblF1ZXJ5T2JqZWN0WyckaW4nXSA9IGluUXVlcnlPYmplY3RbJyRpbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIGluUXVlcnlPYmplY3RbJyRpbiddID0gdmFsdWVzO1xuICB9XG59XG5cbi8vIFJlcGxhY2VzIGEgJGluUXVlcnkgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhblxuLy8gJGluUXVlcnkgY2xhdXNlLlxuLy8gVGhlICRpblF1ZXJ5IGNsYXVzZSB0dXJucyBpbnRvIGFuICRpbiB3aXRoIHZhbHVlcyB0aGF0IGFyZSBqdXN0XG4vLyBwb2ludGVycyB0byB0aGUgb2JqZWN0cyByZXR1cm5lZCBpbiB0aGUgc3VicXVlcnkuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VJblF1ZXJ5ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBpblF1ZXJ5T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckaW5RdWVyeScpO1xuICBpZiAoIWluUXVlcnlPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgaW5RdWVyeSB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gd2hlcmUgYW5kIGNsYXNzTmFtZVxuICB2YXIgaW5RdWVyeVZhbHVlID0gaW5RdWVyeU9iamVjdFsnJGluUXVlcnknXTtcbiAgaWYgKCFpblF1ZXJ5VmFsdWUud2hlcmUgfHwgIWluUXVlcnlWYWx1ZS5jbGFzc05hbWUpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICdpbXByb3BlciB1c2FnZSBvZiAkaW5RdWVyeScpO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGluUXVlcnlWYWx1ZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleVxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZywgdGhpcy5hdXRoLCBpblF1ZXJ5VmFsdWUuY2xhc3NOYW1lLFxuICAgIGluUXVlcnlWYWx1ZS53aGVyZSwgYWRkaXRpb25hbE9wdGlvbnMpO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4oKHJlc3BvbnNlKSA9PiB7XG4gICAgdHJhbnNmb3JtSW5RdWVyeShpblF1ZXJ5T2JqZWN0LCBzdWJxdWVyeS5jbGFzc05hbWUsIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIFJlY3Vyc2UgdG8gcmVwZWF0XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZUluUXVlcnkoKTtcbiAgfSk7XG59O1xuXG5mdW5jdGlvbiB0cmFuc2Zvcm1Ob3RJblF1ZXJ5KG5vdEluUXVlcnlPYmplY3QsIGNsYXNzTmFtZSwgcmVzdWx0cykge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgdmFsdWVzLnB1c2goe1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdElkOiByZXN1bHQub2JqZWN0SWRcbiAgICB9KTtcbiAgfVxuICBkZWxldGUgbm90SW5RdWVyeU9iamVjdFsnJG5vdEluUXVlcnknXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkobm90SW5RdWVyeU9iamVjdFsnJG5pbiddKSkge1xuICAgIG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSA9IG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10gPSB2YWx1ZXM7XG4gIH1cbn1cblxuLy8gUmVwbGFjZXMgYSAkbm90SW5RdWVyeSBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFuXG4vLyAkbm90SW5RdWVyeSBjbGF1c2UuXG4vLyBUaGUgJG5vdEluUXVlcnkgY2xhdXNlIHR1cm5zIGludG8gYSAkbmluIHdpdGggdmFsdWVzIHRoYXQgYXJlIGp1c3Rcbi8vIHBvaW50ZXJzIHRvIHRoZSBvYmplY3RzIHJldHVybmVkIGluIHRoZSBzdWJxdWVyeS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZU5vdEluUXVlcnkgPSBmdW5jdGlvbigpIHtcbiAgdmFyIG5vdEluUXVlcnlPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRub3RJblF1ZXJ5Jyk7XG4gIGlmICghbm90SW5RdWVyeU9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBub3RJblF1ZXJ5IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSB3aGVyZSBhbmQgY2xhc3NOYW1lXG4gIHZhciBub3RJblF1ZXJ5VmFsdWUgPSBub3RJblF1ZXJ5T2JqZWN0Wyckbm90SW5RdWVyeSddO1xuICBpZiAoIW5vdEluUXVlcnlWYWx1ZS53aGVyZSB8fCAhbm90SW5RdWVyeVZhbHVlLmNsYXNzTmFtZSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRub3RJblF1ZXJ5Jyk7XG4gIH1cblxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogbm90SW5RdWVyeVZhbHVlLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5XG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICB2YXIgc3VicXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgIHRoaXMuY29uZmlnLCB0aGlzLmF1dGgsIG5vdEluUXVlcnlWYWx1ZS5jbGFzc05hbWUsXG4gICAgbm90SW5RdWVyeVZhbHVlLndoZXJlLCBhZGRpdGlvbmFsT3B0aW9ucyk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbigocmVzcG9uc2UpID0+IHtcbiAgICB0cmFuc2Zvcm1Ob3RJblF1ZXJ5KG5vdEluUXVlcnlPYmplY3QsIHN1YnF1ZXJ5LmNsYXNzTmFtZSwgcmVzcG9uc2UucmVzdWx0cyk7XG4gICAgLy8gUmVjdXJzZSB0byByZXBlYXRcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpO1xuICB9KTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybVNlbGVjdCA9IChzZWxlY3RPYmplY3QsIGtleSAsb2JqZWN0cykgPT4ge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiBvYmplY3RzKSB7XG4gICAgdmFsdWVzLnB1c2goa2V5LnNwbGl0KCcuJykucmVkdWNlKChvLGkpPT5vW2ldLCByZXN1bHQpKTtcbiAgfVxuICBkZWxldGUgc2VsZWN0T2JqZWN0Wyckc2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdE9iamVjdFsnJGluJ10pKSB7XG4gICAgc2VsZWN0T2JqZWN0WyckaW4nXSA9IHNlbGVjdE9iamVjdFsnJGluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgc2VsZWN0T2JqZWN0WyckaW4nXSA9IHZhbHVlcztcbiAgfVxufVxuXG4vLyBSZXBsYWNlcyBhICRzZWxlY3QgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhXG4vLyAkc2VsZWN0IGNsYXVzZS5cbi8vIFRoZSAkc2VsZWN0IGNsYXVzZSB0dXJucyBpbnRvIGFuICRpbiB3aXRoIHZhbHVlcyBzZWxlY3RlZCBvdXQgb2Zcbi8vIHRoZSBzdWJxdWVyeS5cbi8vIFJldHVybnMgYSBwb3NzaWJsZS1wcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlU2VsZWN0ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBzZWxlY3RPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRzZWxlY3QnKTtcbiAgaWYgKCFzZWxlY3RPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgc2VsZWN0IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSBxdWVyeSBhbmQga2V5XG4gIHZhciBzZWxlY3RWYWx1ZSA9IHNlbGVjdE9iamVjdFsnJHNlbGVjdCddO1xuICAvLyBpT1MgU0RLIGRvbid0IHNlbmQgd2hlcmUgaWYgbm90IHNldCwgbGV0IGl0IHBhc3NcbiAgaWYgKCFzZWxlY3RWYWx1ZS5xdWVyeSB8fFxuICAgICAgIXNlbGVjdFZhbHVlLmtleSB8fFxuICAgICAgdHlwZW9mIHNlbGVjdFZhbHVlLnF1ZXJ5ICE9PSAnb2JqZWN0JyB8fFxuICAgICAgIXNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSB8fFxuICAgICAgT2JqZWN0LmtleXMoc2VsZWN0VmFsdWUpLmxlbmd0aCAhPT0gMikge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRzZWxlY3QnKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBzZWxlY3RWYWx1ZS5xdWVyeS5yZWRpcmVjdENsYXNzTmFtZUZvcktleVxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZywgdGhpcy5hdXRoLCBzZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUsXG4gICAgc2VsZWN0VmFsdWUucXVlcnkud2hlcmUsIGFkZGl0aW9uYWxPcHRpb25zKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKChyZXNwb25zZSkgPT4ge1xuICAgIHRyYW5zZm9ybVNlbGVjdChzZWxlY3RPYmplY3QsIHNlbGVjdFZhbHVlLmtleSwgcmVzcG9uc2UucmVzdWx0cyk7XG4gICAgLy8gS2VlcCByZXBsYWNpbmcgJHNlbGVjdCBjbGF1c2VzXG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZVNlbGVjdCgpO1xuICB9KVxufTtcblxuY29uc3QgdHJhbnNmb3JtRG9udFNlbGVjdCA9IChkb250U2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZSgobyxpKT0+b1tpXSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBkb250U2VsZWN0T2JqZWN0WyckbmluJ10gPSBkb250U2VsZWN0T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgZG9udFNlbGVjdE9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59XG5cbi8vIFJlcGxhY2VzIGEgJGRvbnRTZWxlY3QgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhXG4vLyAkZG9udFNlbGVjdCBjbGF1c2UuXG4vLyBUaGUgJGRvbnRTZWxlY3QgY2xhdXNlIHR1cm5zIGludG8gYW4gJG5pbiB3aXRoIHZhbHVlcyBzZWxlY3RlZCBvdXQgb2Zcbi8vIHRoZSBzdWJxdWVyeS5cbi8vIFJldHVybnMgYSBwb3NzaWJsZS1wcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlRG9udFNlbGVjdCA9IGZ1bmN0aW9uKCkge1xuICB2YXIgZG9udFNlbGVjdE9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJGRvbnRTZWxlY3QnKTtcbiAgaWYgKCFkb250U2VsZWN0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIGRvbnRTZWxlY3QgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHF1ZXJ5IGFuZCBrZXlcbiAgdmFyIGRvbnRTZWxlY3RWYWx1ZSA9IGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmICghZG9udFNlbGVjdFZhbHVlLnF1ZXJ5IHx8XG4gICAgICAhZG9udFNlbGVjdFZhbHVlLmtleSB8fFxuICAgICAgdHlwZW9mIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeSAhPT0gJ29iamVjdCcgfHxcbiAgICAgICFkb250U2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lIHx8XG4gICAgICBPYmplY3Qua2V5cyhkb250U2VsZWN0VmFsdWUpLmxlbmd0aCAhPT0gMikge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRkb250U2VsZWN0Jyk7XG4gIH1cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS5yZWRpcmVjdENsYXNzTmFtZUZvcktleVxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZywgdGhpcy5hdXRoLCBkb250U2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS53aGVyZSwgYWRkaXRpb25hbE9wdGlvbnMpO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4oKHJlc3BvbnNlKSA9PiB7XG4gICAgdHJhbnNmb3JtRG9udFNlbGVjdChkb250U2VsZWN0T2JqZWN0LCBkb250U2VsZWN0VmFsdWUua2V5LCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkZG9udFNlbGVjdCBjbGF1c2VzXG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKTtcbiAgfSlcbn07XG5cbmNvbnN0IGNsZWFuUmVzdWx0T2ZTZW5zaXRpdmVVc2VySW5mbyA9IGZ1bmN0aW9uIChyZXN1bHQsIGF1dGgsIGNvbmZpZykge1xuICBkZWxldGUgcmVzdWx0LnBhc3N3b3JkO1xuXG4gIGlmIChhdXRoLmlzTWFzdGVyIHx8IChhdXRoLnVzZXIgJiYgYXV0aC51c2VyLmlkID09PSByZXN1bHQub2JqZWN0SWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgZm9yIChjb25zdCBmaWVsZCBvZiBjb25maWcudXNlclNlbnNpdGl2ZUZpZWxkcykge1xuICAgIGRlbGV0ZSByZXN1bHRbZmllbGRdO1xuICB9XG59O1xuXG5jb25zdCBjbGVhblJlc3VsdEF1dGhEYXRhID0gZnVuY3Rpb24gKHJlc3VsdCkge1xuICBpZiAocmVzdWx0LmF1dGhEYXRhKSB7XG4gICAgT2JqZWN0LmtleXMocmVzdWx0LmF1dGhEYXRhKS5mb3JFYWNoKChwcm92aWRlcikgPT4ge1xuICAgICAgaWYgKHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoT2JqZWN0LmtleXMocmVzdWx0LmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YTtcbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQgPSAoY29uc3RyYWludCkgPT4ge1xuICBpZiAodHlwZW9mIGNvbnN0cmFpbnQgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIGNvbnN0cmFpbnQ7XG4gIH1cbiAgY29uc3QgZXF1YWxUb09iamVjdCA9IHt9O1xuICBsZXQgaGFzRGlyZWN0Q29uc3RyYWludCA9IGZhbHNlO1xuICBsZXQgaGFzT3BlcmF0b3JDb25zdHJhaW50ID0gZmFsc2U7XG4gIGZvciAoY29uc3Qga2V5IGluIGNvbnN0cmFpbnQpIHtcbiAgICBpZiAoa2V5LmluZGV4T2YoJyQnKSAhPT0gMCkge1xuICAgICAgaGFzRGlyZWN0Q29uc3RyYWludCA9IHRydWU7XG4gICAgICBlcXVhbFRvT2JqZWN0W2tleV0gPSBjb25zdHJhaW50W2tleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGhhc09wZXJhdG9yQ29uc3RyYWludCA9IHRydWU7XG4gICAgfVxuICB9XG4gIGlmIChoYXNEaXJlY3RDb25zdHJhaW50ICYmIGhhc09wZXJhdG9yQ29uc3RyYWludCkge1xuICAgIGNvbnN0cmFpbnRbJyRlcSddID0gZXF1YWxUb09iamVjdDtcbiAgICBPYmplY3Qua2V5cyhlcXVhbFRvT2JqZWN0KS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgIGRlbGV0ZSBjb25zdHJhaW50W2tleV07XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGNvbnN0cmFpbnQ7XG59XG5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZUVxdWFsaXR5ID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0eXBlb2YgdGhpcy5yZXN0V2hlcmUgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3Qga2V5IGluIHRoaXMucmVzdFdoZXJlKSB7XG4gICAgdGhpcy5yZXN0V2hlcmVba2V5XSA9IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQodGhpcy5yZXN0V2hlcmVba2V5XSk7XG4gIH1cbn1cblxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZXRoZXIgaXQgd2FzIHN1Y2Nlc3NmdWwuXG4vLyBQb3B1bGF0ZXMgdGhpcy5yZXNwb25zZSB3aXRoIGFuIG9iamVjdCB0aGF0IG9ubHkgaGFzICdyZXN1bHRzJy5cblJlc3RRdWVyeS5wcm90b3R5cGUucnVuRmluZCA9IGZ1bmN0aW9uKG9wdGlvbnMgPSB7fSkge1xuICBpZiAodGhpcy5maW5kT3B0aW9ucy5saW1pdCA9PT0gMCkge1xuICAgIHRoaXMucmVzcG9uc2UgPSB7cmVzdWx0czogW119O1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICBjb25zdCBmaW5kT3B0aW9ucyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuZmluZE9wdGlvbnMpO1xuICBpZiAodGhpcy5rZXlzKSB7XG4gICAgZmluZE9wdGlvbnMua2V5cyA9IHRoaXMua2V5cy5tYXAoKGtleSkgPT4ge1xuICAgICAgcmV0dXJuIGtleS5zcGxpdCgnLicpWzBdO1xuICAgIH0pO1xuICB9XG4gIGlmIChvcHRpb25zLm9wKSB7XG4gICAgZmluZE9wdGlvbnMub3AgPSBvcHRpb25zLm9wO1xuICB9XG4gIGlmICh0aGlzLmlzV3JpdGUpIHtcbiAgICBmaW5kT3B0aW9ucy5pc1dyaXRlID0gdHJ1ZTtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZXN0V2hlcmUsIGZpbmRPcHRpb25zKVxuICAgIC50aGVuKChyZXN1bHRzKSA9PiB7XG4gICAgICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgICAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICAgICAgICBjbGVhblJlc3VsdE9mU2Vuc2l0aXZlVXNlckluZm8ocmVzdWx0LCB0aGlzLmF1dGgsIHRoaXMuY29uZmlnKTtcbiAgICAgICAgICBjbGVhblJlc3VsdEF1dGhEYXRhKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHJlc3VsdHMpO1xuXG4gICAgICBpZiAodGhpcy5yZWRpcmVjdENsYXNzTmFtZSkge1xuICAgICAgICBmb3IgKHZhciByIG9mIHJlc3VsdHMpIHtcbiAgICAgICAgICByLmNsYXNzTmFtZSA9IHRoaXMucmVkaXJlY3RDbGFzc05hbWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7cmVzdWx0czogcmVzdWx0c307XG4gICAgfSk7XG59O1xuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hldGhlciBpdCB3YXMgc3VjY2Vzc2Z1bC5cbi8vIFBvcHVsYXRlcyB0aGlzLnJlc3BvbnNlLmNvdW50IHdpdGggdGhlIGNvdW50XG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkNvdW50ID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5kb0NvdW50KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuZmluZE9wdGlvbnMuY291bnQgPSB0cnVlO1xuICBkZWxldGUgdGhpcy5maW5kT3B0aW9ucy5za2lwO1xuICBkZWxldGUgdGhpcy5maW5kT3B0aW9ucy5saW1pdDtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQodGhpcy5jbGFzc05hbWUsIHRoaXMucmVzdFdoZXJlLCB0aGlzLmZpbmRPcHRpb25zKVxuICAgIC50aGVuKChjKSA9PiB7XG4gICAgICB0aGlzLnJlc3BvbnNlLmNvdW50ID0gYztcbiAgICB9KTtcbn07XG5cbi8vIEF1Z21lbnRzIHRoaXMucmVzcG9uc2Ugd2l0aCBhbGwgcG9pbnRlcnMgb24gYW4gb2JqZWN0XG5SZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUluY2x1ZGVBbGwgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLmluY2x1ZGVBbGwpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoKVxuICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEodGhpcy5jbGFzc05hbWUpKVxuICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICBjb25zdCBpbmNsdWRlRmllbGRzID0gW107XG4gICAgICBjb25zdCBrZXlGaWVsZHMgPSBbXTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gc2NoZW1hLmZpZWxkcykge1xuICAgICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgICBpbmNsdWRlRmllbGRzLnB1c2goW2ZpZWxkXSk7XG4gICAgICAgICAga2V5RmllbGRzLnB1c2goZmllbGQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBBZGQgZmllbGRzIHRvIGluY2x1ZGUsIGtleXMsIHJlbW92ZSBkdXBzXG4gICAgICB0aGlzLmluY2x1ZGUgPSBbLi4ubmV3IFNldChbLi4udGhpcy5pbmNsdWRlLCAuLi5pbmNsdWRlRmllbGRzXSldO1xuICAgICAgLy8gaWYgdGhpcy5rZXlzIG5vdCBzZXQsIHRoZW4gYWxsIGtleXMgYXJlIGFscmVhZHkgaW5jbHVkZWRcbiAgICAgIGlmICh0aGlzLmtleXMpIHtcbiAgICAgICAgdGhpcy5rZXlzID0gWy4uLm5ldyBTZXQoWy4uLnRoaXMua2V5cywgLi4ua2V5RmllbGRzXSldO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuLy8gQXVnbWVudHMgdGhpcy5yZXNwb25zZSB3aXRoIGRhdGEgYXQgdGhlIHBhdGhzIHByb3ZpZGVkIGluIHRoaXMuaW5jbHVkZS5cblJlc3RRdWVyeS5wcm90b3R5cGUuaGFuZGxlSW5jbHVkZSA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5pbmNsdWRlLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHBhdGhSZXNwb25zZSA9IGluY2x1ZGVQYXRoKHRoaXMuY29uZmlnLCB0aGlzLmF1dGgsXG4gICAgdGhpcy5yZXNwb25zZSwgdGhpcy5pbmNsdWRlWzBdLCB0aGlzLnJlc3RPcHRpb25zKTtcbiAgaWYgKHBhdGhSZXNwb25zZS50aGVuKSB7XG4gICAgcmV0dXJuIHBhdGhSZXNwb25zZS50aGVuKChuZXdSZXNwb25zZSkgPT4ge1xuICAgICAgdGhpcy5yZXNwb25zZSA9IG5ld1Jlc3BvbnNlO1xuICAgICAgdGhpcy5pbmNsdWRlID0gdGhpcy5pbmNsdWRlLnNsaWNlKDEpO1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlSW5jbHVkZSgpO1xuICAgIH0pO1xuICB9IGVsc2UgaWYgKHRoaXMuaW5jbHVkZS5sZW5ndGggPiAwKSB7XG4gICAgdGhpcy5pbmNsdWRlID0gdGhpcy5pbmNsdWRlLnNsaWNlKDEpO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGUoKTtcbiAgfVxuXG4gIHJldHVybiBwYXRoUmVzcG9uc2U7XG59O1xuXG4vL1JldHVybnMgYSBwcm9taXNlIG9mIGEgcHJvY2Vzc2VkIHNldCBvZiByZXN1bHRzXG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkFmdGVyRmluZFRyaWdnZXIgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyRmluZCcgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJGaW5kSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmFmdGVyRmluZCwgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICghaGFzQWZ0ZXJGaW5kSG9vaykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBTa2lwIEFnZ3JlZ2F0ZSBhbmQgRGlzdGluY3QgUXVlcmllc1xuICBpZiAodGhpcy5maW5kT3B0aW9ucy5waXBlbGluZSB8fCB0aGlzLmZpbmRPcHRpb25zLmRpc3RpbmN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJ1biBhZnRlckZpbmQgdHJpZ2dlciBhbmQgc2V0IHRoZSBuZXcgcmVzdWx0c1xuICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyKHRyaWdnZXJzLlR5cGVzLmFmdGVyRmluZCwgdGhpcy5hdXRoLCB0aGlzLmNsYXNzTmFtZSx0aGlzLnJlc3BvbnNlLnJlc3VsdHMsIHRoaXMuY29uZmlnKS50aGVuKChyZXN1bHRzKSA9PiB7XG4gICAgLy8gRW5zdXJlIHdlIHByb3Blcmx5IHNldCB0aGUgY2xhc3NOYW1lIGJhY2tcbiAgICBpZiAodGhpcy5yZWRpcmVjdENsYXNzTmFtZSkge1xuICAgICAgdGhpcy5yZXNwb25zZS5yZXN1bHRzID0gcmVzdWx0cy5tYXAoKG9iamVjdCkgPT4ge1xuICAgICAgICBpZiAob2JqZWN0IGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgICAgb2JqZWN0ID0gb2JqZWN0LnRvSlNPTigpO1xuICAgICAgICB9XG4gICAgICAgIG9iamVjdC5jbGFzc05hbWUgPSB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lO1xuICAgICAgICByZXR1cm4gb2JqZWN0O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHM7XG4gICAgfVxuICB9KTtcbn07XG5cbi8vIEFkZHMgaW5jbHVkZWQgdmFsdWVzIHRvIHRoZSByZXNwb25zZS5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkIG5hbWVzLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIGFuIGF1Z21lbnRlZCByZXNwb25zZS5cbmZ1bmN0aW9uIGluY2x1ZGVQYXRoKGNvbmZpZywgYXV0aCwgcmVzcG9uc2UsIHBhdGgsIHJlc3RPcHRpb25zID0ge30pIHtcbiAgdmFyIHBvaW50ZXJzID0gZmluZFBvaW50ZXJzKHJlc3BvbnNlLnJlc3VsdHMsIHBhdGgpO1xuICBpZiAocG9pbnRlcnMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgcG9pbnRlcnNIYXNoID0ge307XG4gIGZvciAodmFyIHBvaW50ZXIgb2YgcG9pbnRlcnMpIHtcbiAgICBpZiAoIXBvaW50ZXIpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjbGFzc05hbWUgPSBwb2ludGVyLmNsYXNzTmFtZTtcbiAgICAvLyBvbmx5IGluY2x1ZGUgdGhlIGdvb2QgcG9pbnRlcnNcbiAgICBpZiAoY2xhc3NOYW1lKSB7XG4gICAgICBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSA9IHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdIHx8IG5ldyBTZXQoKTtcbiAgICAgIHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdLmFkZChwb2ludGVyLm9iamVjdElkKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgaW5jbHVkZVJlc3RPcHRpb25zID0ge307XG4gIGlmIChyZXN0T3B0aW9ucy5rZXlzKSB7XG4gICAgY29uc3Qga2V5cyA9IG5ldyBTZXQocmVzdE9wdGlvbnMua2V5cy5zcGxpdCgnLCcpKTtcbiAgICBjb25zdCBrZXlTZXQgPSBBcnJheS5mcm9tKGtleXMpLnJlZHVjZSgoc2V0LCBrZXkpID0+IHtcbiAgICAgIGNvbnN0IGtleVBhdGggPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgIGxldCBpID0gMDtcbiAgICAgIGZvciAoaTsgaSA8IHBhdGgubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHBhdGhbaV0gIT0ga2V5UGF0aFtpXSkge1xuICAgICAgICAgIHJldHVybiBzZXQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChpIDwga2V5UGF0aC5sZW5ndGgpIHtcbiAgICAgICAgc2V0LmFkZChrZXlQYXRoW2ldKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzZXQ7XG4gICAgfSwgbmV3IFNldCgpKTtcbiAgICBpZiAoa2V5U2V0LnNpemUgPiAwKSB7XG4gICAgICBpbmNsdWRlUmVzdE9wdGlvbnMua2V5cyA9IEFycmF5LmZyb20oa2V5U2V0KS5qb2luKCcsJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSkge1xuICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID0gcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IE9iamVjdC5rZXlzKHBvaW50ZXJzSGFzaCkubWFwKChjbGFzc05hbWUpID0+IHtcbiAgICBjb25zdCBvYmplY3RJZHMgPSBBcnJheS5mcm9tKHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdKTtcbiAgICBsZXQgd2hlcmU7XG4gICAgaWYgKG9iamVjdElkcy5sZW5ndGggPT09IDEpIHtcbiAgICAgIHdoZXJlID0geydvYmplY3RJZCc6IG9iamVjdElkc1swXX07XG4gICAgfSBlbHNlIHtcbiAgICAgIHdoZXJlID0geydvYmplY3RJZCc6IHsnJGluJzogb2JqZWN0SWRzfX07XG4gICAgfVxuICAgIHZhciBxdWVyeSA9IG5ldyBSZXN0UXVlcnkoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIHdoZXJlLCBpbmNsdWRlUmVzdE9wdGlvbnMpO1xuICAgIHJldHVybiBxdWVyeS5leGVjdXRlKHtvcDogJ2dldCd9KS50aGVuKChyZXN1bHRzKSA9PiB7XG4gICAgICByZXN1bHRzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0cyk7XG4gICAgfSlcbiAgfSlcblxuICAvLyBHZXQgdGhlIG9iamVjdHMgZm9yIGFsbCB0aGVzZSBvYmplY3QgaWRzXG4gIHJldHVybiBQcm9taXNlLmFsbChxdWVyeVByb21pc2VzKS50aGVuKChyZXNwb25zZXMpID0+IHtcbiAgICB2YXIgcmVwbGFjZSA9IHJlc3BvbnNlcy5yZWR1Y2UoKHJlcGxhY2UsIGluY2x1ZGVSZXNwb25zZSkgPT4ge1xuICAgICAgZm9yICh2YXIgb2JqIG9mIGluY2x1ZGVSZXNwb25zZS5yZXN1bHRzKSB7XG4gICAgICAgIG9iai5fX3R5cGUgPSAnT2JqZWN0JztcbiAgICAgICAgb2JqLmNsYXNzTmFtZSA9IGluY2x1ZGVSZXNwb25zZS5jbGFzc05hbWU7XG5cbiAgICAgICAgaWYgKG9iai5jbGFzc05hbWUgPT0gXCJfVXNlclwiICYmICFhdXRoLmlzTWFzdGVyKSB7XG4gICAgICAgICAgZGVsZXRlIG9iai5zZXNzaW9uVG9rZW47XG4gICAgICAgICAgZGVsZXRlIG9iai5hdXRoRGF0YTtcbiAgICAgICAgfVxuICAgICAgICByZXBsYWNlW29iai5vYmplY3RJZF0gPSBvYmo7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVwbGFjZTtcbiAgICB9LCB7fSlcblxuICAgIHZhciByZXNwID0ge1xuICAgICAgcmVzdWx0czogcmVwbGFjZVBvaW50ZXJzKHJlc3BvbnNlLnJlc3VsdHMsIHBhdGgsIHJlcGxhY2UpXG4gICAgfTtcbiAgICBpZiAocmVzcG9uc2UuY291bnQpIHtcbiAgICAgIHJlc3AuY291bnQgPSByZXNwb25zZS5jb3VudDtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3A7XG4gIH0pO1xufVxuXG4vLyBPYmplY3QgbWF5IGJlIGEgbGlzdCBvZiBSRVNULWZvcm1hdCBvYmplY3QgdG8gZmluZCBwb2ludGVycyBpbiwgb3Jcbi8vIGl0IG1heSBiZSBhIHNpbmdsZSBvYmplY3QuXG4vLyBJZiB0aGUgcGF0aCB5aWVsZHMgdGhpbmdzIHRoYXQgYXJlbid0IHBvaW50ZXJzLCB0aGlzIHRocm93cyBhbiBlcnJvci5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIFJldHVybnMgYSBsaXN0IG9mIHBvaW50ZXJzIGluIFJFU1QgZm9ybWF0LlxuZnVuY3Rpb24gZmluZFBvaW50ZXJzKG9iamVjdCwgcGF0aCkge1xuICBpZiAob2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICB2YXIgYW5zd2VyID0gW107XG4gICAgZm9yICh2YXIgeCBvZiBvYmplY3QpIHtcbiAgICAgIGFuc3dlciA9IGFuc3dlci5jb25jYXQoZmluZFBvaW50ZXJzKHgsIHBhdGgpKTtcbiAgICB9XG4gICAgcmV0dXJuIGFuc3dlcjtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKHBhdGgubGVuZ3RoID09IDApIHtcbiAgICBpZiAob2JqZWN0ID09PSBudWxsIHx8IG9iamVjdC5fX3R5cGUgPT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gW29iamVjdF07XG4gICAgfVxuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIHZhciBzdWJvYmplY3QgPSBvYmplY3RbcGF0aFswXV07XG4gIGlmICghc3Vib2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIHJldHVybiBmaW5kUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLy8gT2JqZWN0IG1heSBiZSBhIGxpc3Qgb2YgUkVTVC1mb3JtYXQgb2JqZWN0cyB0byByZXBsYWNlIHBvaW50ZXJzXG4vLyBpbiwgb3IgaXQgbWF5IGJlIGEgc2luZ2xlIG9iamVjdC5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIHJlcGxhY2UgaXMgYSBtYXAgZnJvbSBvYmplY3QgaWQgLT4gb2JqZWN0LlxuLy8gUmV0dXJucyBzb21ldGhpbmcgYW5hbG9nb3VzIHRvIG9iamVjdCwgYnV0IHdpdGggdGhlIGFwcHJvcHJpYXRlXG4vLyBwb2ludGVycyBpbmZsYXRlZC5cbmZ1bmN0aW9uIHJlcGxhY2VQb2ludGVycyhvYmplY3QsIHBhdGgsIHJlcGxhY2UpIHtcbiAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgcmV0dXJuIG9iamVjdC5tYXAoKG9iaikgPT4gcmVwbGFjZVBvaW50ZXJzKG9iaiwgcGF0aCwgcmVwbGFjZSkpXG4gICAgICAuZmlsdGVyKChvYmopID0+IHR5cGVvZiBvYmogIT09ICd1bmRlZmluZWQnKTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIGlmIChwYXRoLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChvYmplY3QgJiYgb2JqZWN0Ll9fdHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gcmVwbGFjZVtvYmplY3Qub2JqZWN0SWRdO1xuICAgIH1cbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgdmFyIHN1Ym9iamVjdCA9IG9iamVjdFtwYXRoWzBdXTtcbiAgaWYgKCFzdWJvYmplY3QpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIHZhciBuZXdzdWIgPSByZXBsYWNlUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpLCByZXBsYWNlKTtcbiAgdmFyIGFuc3dlciA9IHt9O1xuICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgaWYgKGtleSA9PSBwYXRoWzBdKSB7XG4gICAgICBhbnN3ZXJba2V5XSA9IG5ld3N1YjtcbiAgICB9IGVsc2Uge1xuICAgICAgYW5zd2VyW2tleV0gPSBvYmplY3Rba2V5XTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGFuc3dlcjtcbn1cblxuLy8gRmluZHMgYSBzdWJvYmplY3QgdGhhdCBoYXMgdGhlIGdpdmVuIGtleSwgaWYgdGhlcmUgaXMgb25lLlxuLy8gUmV0dXJucyB1bmRlZmluZWQgb3RoZXJ3aXNlLlxuZnVuY3Rpb24gZmluZE9iamVjdFdpdGhLZXkocm9vdCwga2V5KSB7XG4gIGlmICh0eXBlb2Ygcm9vdCAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHJvb3QgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgIGZvciAodmFyIGl0ZW0gb2Ygcm9vdCkge1xuICAgICAgY29uc3QgYW5zd2VyID0gZmluZE9iamVjdFdpdGhLZXkoaXRlbSwga2V5KTtcbiAgICAgIGlmIChhbnN3ZXIpIHtcbiAgICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKHJvb3QgJiYgcm9vdFtrZXldKSB7XG4gICAgcmV0dXJuIHJvb3Q7XG4gIH1cbiAgZm9yICh2YXIgc3Via2V5IGluIHJvb3QpIHtcbiAgICBjb25zdCBhbnN3ZXIgPSBmaW5kT2JqZWN0V2l0aEtleShyb290W3N1YmtleV0sIGtleSk7XG4gICAgaWYgKGFuc3dlcikge1xuICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBSZXN0UXVlcnk7XG4iXX0=