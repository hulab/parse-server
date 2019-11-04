"use strict";

// An object that encapsulates everything we need to run a 'find'
// operation, encoded in the REST API format.
const AWSXRay = require('aws-xray-sdk');

var SchemaController = require('./Controllers/SchemaController');

var Parse = require('parse/node').Parse;

const triggers = require('./triggers');

const {
  continueWhile
} = require('parse/lib/node/promiseUtils');

const AlwaysSelectedKeys = ['objectId', 'createdAt', 'updatedAt', 'ACL']; // restOptions can include:
//   skip
//   limit
//   order
//   count
//   include
//   keys
//   excludeKeys
//   redirectClassNameForKey
//   readPreference
//   includeReadPreference
//   subqueryReadPreference

function RestQuery(config, auth, className, restWhere = {}, restOptions = {}, clientSDK) {
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.restWhere = restWhere;
  this.restOptions = restOptions;
  this.clientSDK = clientSDK;
  this.response = null;
  this.findOptions = {};

  if (!this.auth.isMaster) {
    if (this.className == '_Session') {
      if (!this.auth.user) {
        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
      }

      this.restWhere = {
        $and: [this.restWhere, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }

  this.doCount = false;
  this.includeAll = false; // The format for this.include is not the same as the format for the
  // include option - it's the paths we should include, in order,
  // stored as arrays, taking into account that we need to include foo
  // before including foo.bar. Also it should dedupe.
  // For example, passing an arg of include=foo.bar,foo.baz could lead to
  // this.include = [['foo'], ['foo', 'baz'], ['foo', 'bar']]

  this.include = []; // If we have keys, we probably want to force some includes (n-1 level)
  // See issue: https://github.com/parse-community/parse-server/issues/3185

  if (Object.prototype.hasOwnProperty.call(restOptions, 'keys')) {
    const keysForInclude = restOptions.keys.split(',').filter(key => {
      // At least 2 components
      return key.split('.').length > 1;
    }).map(key => {
      // Slice the last component (a.b.c -> a.b)
      // Otherwise we'll include one level too much.
      return key.slice(0, key.lastIndexOf('.'));
    }).join(','); // Concat the possibly present include string with the one from the keys
    // Dedup / sorting is handle in 'include' case.

    if (keysForInclude.length > 0) {
      if (!restOptions.include || restOptions.include.length == 0) {
        restOptions.include = keysForInclude;
      } else {
        restOptions.include += ',' + keysForInclude;
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

      case 'excludeKeys':
        {
          const exclude = restOptions.excludeKeys.split(',').filter(k => AlwaysSelectedKeys.indexOf(k) < 0);
          this.excludeKeys = Array.from(new Set(exclude));
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
            sortMap.score = {
              $meta: 'textScore'
            };
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
          } // Load the existing includes (from keys)


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
} // A convenient method to perform all the steps of processing a query
// in order.
// Returns a promise for the response - an object with optional keys
// 'results' and 'count'.
// TODO: consolidate the replaceX functions


RestQuery.prototype.execute = function (executeOptions) {
  return Promise.resolve().then(() => {
    return tracePromise('buildRestWhere', this.className, this.buildRestWhere());
  }).then(() => {
    return tracePromise('handleIncludeAll', this.className, this.handleIncludeAll());
  }).then(() => {
    return tracePromise('handleExcludeKeys', this.className, this.handleExcludeKeys());
  }).then(() => {
    return tracePromise('runFind', this.className, this.runFind(executeOptions));
  }).then(() => {
    return tracePromise('runCount', this.className, this.runCount());
  }).then(() => {
    return tracePromise('handleInclude', this.className, this.handleInclude());
  }).then(() => {
    return tracePromise('runAfterFindTrigger', this.className, this.runAfterFindTrigger());
  }).then(() => {
    return this.response;
  });
};

RestQuery.prototype.each = function (callback) {
  const {
    config,
    auth,
    className,
    restWhere,
    restOptions,
    clientSDK
  } = this; // if the limit is set, use it

  restOptions.limit = restOptions.limit || 100;
  restOptions.order = 'objectId';
  let finished = false;
  return continueWhile(() => {
    return !finished;
  }, async () => {
    const query = new RestQuery(config, auth, className, restWhere, restOptions, clientSDK);
    const {
      results
    } = await query.execute();
    results.forEach(callback);
    finished = results.length < restOptions.limit;

    if (!finished) {
      restWhere.objectId = Object.assign({}, restWhere.objectId, {
        $gt: results[results.length - 1].objectId
      });
    }
  });
};

RestQuery.prototype.buildRestWhere = function () {
  return Promise.resolve().then(() => {
    return tracePromise('getUserAndRoleACL', this.className, this.getUserAndRoleACL());
  }).then(() => {
    return tracePromise('redirectClassNameForKey', this.className, this.redirectClassNameForKey());
  }).then(() => {
    return tracePromise('validateClientClassCreation', this.className, this.validateClientClassCreation());
  }).then(() => {
    return tracePromise('replaceSelect', this.className, this.replaceSelect());
  }).then(() => {
    return tracePromise('replaceDontSelect', this.className, this.replaceDontSelect());
  }).then(() => {
    return tracePromise('replaceInQuery', this.className, this.replaceInQuery());
  }).then(() => {
    return tracePromise('replaceNotInQuery', this.className, this.replaceNotInQuery());
  }).then(() => {
    return tracePromise('replaceEquality', this.className, this.replaceEquality());
  });
}; // Uses the Auth object to get the list of roles, adds the user id


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
}; // Changes the className if redirectClassNameForKey is set.
// Returns a promise.


RestQuery.prototype.redirectClassNameForKey = function () {
  if (!this.redirectKey) {
    return Promise.resolve();
  } // We need to change the class name based on the schema


  return this.config.database.redirectClassNameForKey(this.className, this.redirectKey).then(newClassName => {
    this.className = newClassName;
    this.redirectClassName = newClassName;
  });
}; // Validates this operation against the allowClientClassCreation config.


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
} // Replaces a $inQuery clause by running the subquery, if there is an
// $inQuery clause.
// The $inQuery clause turns into an $in with values that are just
// pointers to the objects returned in the subquery.


RestQuery.prototype.replaceInQuery = function () {
  var inQueryObject = findObjectWithKey(this.restWhere, '$inQuery');

  if (!inQueryObject) {
    return;
  } // The inQuery value must have precisely two keys - where and className


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
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, inQueryValue.className, inQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformInQuery(inQueryObject, subquery.className, response.results); // Recurse to repeat

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
} // Replaces a $notInQuery clause by running the subquery, if there is an
// $notInQuery clause.
// The $notInQuery clause turns into a $nin with values that are just
// pointers to the objects returned in the subquery.


RestQuery.prototype.replaceNotInQuery = function () {
  var notInQueryObject = findObjectWithKey(this.restWhere, '$notInQuery');

  if (!notInQueryObject) {
    return;
  } // The notInQuery value must have precisely two keys - where and className


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
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, notInQueryValue.className, notInQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformNotInQuery(notInQueryObject, subquery.className, response.results); // Recurse to repeat

    return this.replaceNotInQuery();
  });
}; // Used to get the deepest object from json using dot notation.


const getDeepestObjectFromKey = (json, key, idx, src) => {
  if (key in json) {
    return json[key];
  }

  src.splice(1); // Exit Early
};

const transformSelect = (selectObject, key, objects) => {
  var values = [];

  for (var result of objects) {
    values.push(key.split('.').reduce(getDeepestObjectFromKey, result));
  }

  delete selectObject['$select'];

  if (Array.isArray(selectObject['$in'])) {
    selectObject['$in'] = selectObject['$in'].concat(values);
  } else {
    selectObject['$in'] = values;
  }
}; // Replaces a $select clause by running the subquery, if there is a
// $select clause.
// The $select clause turns into an $in with values selected out of
// the subquery.
// Returns a possible-promise.


RestQuery.prototype.replaceSelect = function () {
  var selectObject = findObjectWithKey(this.restWhere, '$select');

  if (!selectObject) {
    return;
  } // The select value must have precisely two keys - query and key


  var selectValue = selectObject['$select']; // iOS SDK don't send where if not set, let it pass

  if (!selectValue.query || !selectValue.key || typeof selectValue.query !== 'object' || !selectValue.query.className || Object.keys(selectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $select');
  }

  const additionalOptions = {
    redirectClassNameForKey: selectValue.query.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, selectValue.query.className, selectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformSelect(selectObject, selectValue.key, response.results); // Keep replacing $select clauses

    return this.replaceSelect();
  });
};

const transformDontSelect = (dontSelectObject, key, objects) => {
  var values = [];

  for (var result of objects) {
    values.push(key.split('.').reduce(getDeepestObjectFromKey, result));
  }

  delete dontSelectObject['$dontSelect'];

  if (Array.isArray(dontSelectObject['$nin'])) {
    dontSelectObject['$nin'] = dontSelectObject['$nin'].concat(values);
  } else {
    dontSelectObject['$nin'] = values;
  }
}; // Replaces a $dontSelect clause by running the subquery, if there is a
// $dontSelect clause.
// The $dontSelect clause turns into an $nin with values selected out of
// the subquery.
// Returns a possible-promise.


RestQuery.prototype.replaceDontSelect = function () {
  var dontSelectObject = findObjectWithKey(this.restWhere, '$dontSelect');

  if (!dontSelectObject) {
    return;
  } // The dontSelect value must have precisely two keys - query and key


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
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, dontSelectValue.query.className, dontSelectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformDontSelect(dontSelectObject, dontSelectValue.key, response.results); // Keep replacing $dontSelect clauses

    return this.replaceDontSelect();
  });
};

const cleanResultAuthData = function (result) {
  delete result.password;

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
}; // Returns a promise for whether it was successful.
// Populates this.response with an object that only has 'results'.


RestQuery.prototype.runFind = function (options = {}) {
  if (this.findOptions.limit === 0) {
    this.response = {
      results: []
    };
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

  return this.config.database.find(this.className, this.restWhere, findOptions, this.auth).then(results => {
    if (this.className === '_User') {
      for (var result of results) {
        cleanResultAuthData(result);
      }
    }

    this.config.filesController.expandFilesInObject(this.config, results);

    if (this.redirectClassName) {
      for (var r of results) {
        r.className = this.redirectClassName;
      }
    }

    this.response = {
      results: results
    };
  });
}; // Returns a promise for whether it was successful.
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
}; // Augments this.response with all pointers on an object


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
    } // Add fields to include, keys, remove dups


    this.include = [...new Set([...this.include, ...includeFields])]; // if this.keys not set, then all keys are already included

    if (this.keys) {
      this.keys = [...new Set([...this.keys, ...keyFields])];
    }
  });
}; // Updates property `this.keys` to contain all keys but the ones unselected.


RestQuery.prototype.handleExcludeKeys = function () {
  if (!this.excludeKeys) {
    return;
  }

  if (this.keys) {
    this.keys = this.keys.filter(k => !this.excludeKeys.includes(k));
    return;
  }

  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const fields = Object.keys(schema.fields);
    this.keys = fields.filter(k => !this.excludeKeys.includes(k));
  });
}; // Augments this.response with data at the paths provided in this.include.


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
}; //Returns a promise of a processed set of results


RestQuery.prototype.runAfterFindTrigger = function () {
  if (!this.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'afterFind' trigger for this class.


  const hasAfterFindHook = triggers.triggerExists(this.className, triggers.Types.afterFind, this.config.applicationId);

  if (!hasAfterFindHook) {
    return Promise.resolve();
  } // Skip Aggregate and Distinct Queries


  if (this.findOptions.pipeline || this.findOptions.distinct) {
    return Promise.resolve();
  } // Run afterFind trigger and set the new results


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
}; // Adds included values to the response.
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

    const className = pointer.className; // only include the good pointers

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
  } else if (restOptions.readPreference) {
    includeRestOptions.readPreference = restOptions.readPreference;
  }

  const queryPromises = Object.keys(pointersHash).map(className => {
    const objectIds = Array.from(pointersHash[className]);
    let where;

    if (objectIds.length === 1) {
      where = {
        objectId: objectIds[0]
      };
    } else {
      where = {
        objectId: {
          $in: objectIds
        }
      };
    }

    var query = new RestQuery(config, auth, className, where, includeRestOptions);
    return query.execute({
      op: 'get'
    }).then(results => {
      results.className = className;
      return Promise.resolve(results);
    });
  }); // Get the objects for all these object ids

  return Promise.all(queryPromises).then(responses => {
    var replace = responses.reduce((replace, includeResponse) => {
      for (var obj of includeResponse.results) {
        obj.__type = 'Object';
        obj.className = includeResponse.className;

        if (obj.className == '_User' && !auth.isMaster) {
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
} // Object may be a list of REST-format object to find pointers in, or
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
} // Object may be a list of REST-format objects to replace pointers
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
} // Finds a subobject that has the given key, if there is one.
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

function tracePromise(operation, className, promise = Promise.resolve()) {
  const parent = AWSXRay.getSegment();

  if (!parent) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    AWSXRay.captureAsyncFunc(`Parse-Server_RestQuery_${operation}_${className}`, subsegment => {
      subsegment && subsegment.addAnnotation('Controller', 'RestQuery');
      subsegment && subsegment.addAnnotation('Operation', operation);
      subsegment && subsegment.addAnnotation('ClassName', className);
      (promise instanceof Promise ? promise : Promise.resolve(promise)).then(function (result) {
        resolve(result);
        subsegment && subsegment.close();
      }, function (error) {
        reject(error);
        subsegment && subsegment.close(error);
      });
    });
  });
}

module.exports = RestQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0UXVlcnkuanMiXSwibmFtZXMiOlsiQVdTWFJheSIsInJlcXVpcmUiLCJTY2hlbWFDb250cm9sbGVyIiwiUGFyc2UiLCJ0cmlnZ2VycyIsImNvbnRpbnVlV2hpbGUiLCJBbHdheXNTZWxlY3RlZEtleXMiLCJSZXN0UXVlcnkiLCJjb25maWciLCJhdXRoIiwiY2xhc3NOYW1lIiwicmVzdFdoZXJlIiwicmVzdE9wdGlvbnMiLCJjbGllbnRTREsiLCJyZXNwb25zZSIsImZpbmRPcHRpb25zIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiRXJyb3IiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCIkYW5kIiwiX190eXBlIiwib2JqZWN0SWQiLCJpZCIsImRvQ291bnQiLCJpbmNsdWRlQWxsIiwiaW5jbHVkZSIsIk9iamVjdCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImtleXNGb3JJbmNsdWRlIiwia2V5cyIsInNwbGl0IiwiZmlsdGVyIiwia2V5IiwibGVuZ3RoIiwibWFwIiwic2xpY2UiLCJsYXN0SW5kZXhPZiIsImpvaW4iLCJvcHRpb24iLCJjb25jYXQiLCJBcnJheSIsImZyb20iLCJTZXQiLCJleGNsdWRlIiwiZXhjbHVkZUtleXMiLCJrIiwiaW5kZXhPZiIsImZpZWxkcyIsIm9yZGVyIiwic29ydCIsInJlZHVjZSIsInNvcnRNYXAiLCJmaWVsZCIsInRyaW0iLCJzY29yZSIsIiRtZXRhIiwicGF0aHMiLCJpbmNsdWRlcyIsInBhdGhTZXQiLCJtZW1vIiwicGF0aCIsImluZGV4IiwicGFydHMiLCJzIiwiYSIsImIiLCJyZWRpcmVjdEtleSIsInJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IiwicmVkaXJlY3RDbGFzc05hbWUiLCJJTlZBTElEX0pTT04iLCJleGVjdXRlIiwiZXhlY3V0ZU9wdGlvbnMiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJ0cmFjZVByb21pc2UiLCJidWlsZFJlc3RXaGVyZSIsImhhbmRsZUluY2x1ZGVBbGwiLCJoYW5kbGVFeGNsdWRlS2V5cyIsInJ1bkZpbmQiLCJydW5Db3VudCIsImhhbmRsZUluY2x1ZGUiLCJydW5BZnRlckZpbmRUcmlnZ2VyIiwiZWFjaCIsImNhbGxiYWNrIiwibGltaXQiLCJmaW5pc2hlZCIsInF1ZXJ5IiwicmVzdWx0cyIsImZvckVhY2giLCJhc3NpZ24iLCIkZ3QiLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsInJlcGxhY2VTZWxlY3QiLCJyZXBsYWNlRG9udFNlbGVjdCIsInJlcGxhY2VJblF1ZXJ5IiwicmVwbGFjZU5vdEluUXVlcnkiLCJyZXBsYWNlRXF1YWxpdHkiLCJhY2wiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImRhdGFiYXNlIiwibmV3Q2xhc3NOYW1lIiwiYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwic3lzdGVtQ2xhc3NlcyIsImxvYWRTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwiaGFzQ2xhc3MiLCJPUEVSQVRJT05fRk9SQklEREVOIiwidHJhbnNmb3JtSW5RdWVyeSIsImluUXVlcnlPYmplY3QiLCJ2YWx1ZXMiLCJyZXN1bHQiLCJwdXNoIiwiaXNBcnJheSIsImZpbmRPYmplY3RXaXRoS2V5IiwiaW5RdWVyeVZhbHVlIiwid2hlcmUiLCJJTlZBTElEX1FVRVJZIiwiYWRkaXRpb25hbE9wdGlvbnMiLCJzdWJxdWVyeVJlYWRQcmVmZXJlbmNlIiwicmVhZFByZWZlcmVuY2UiLCJzdWJxdWVyeSIsInRyYW5zZm9ybU5vdEluUXVlcnkiLCJub3RJblF1ZXJ5T2JqZWN0Iiwibm90SW5RdWVyeVZhbHVlIiwiZ2V0RGVlcGVzdE9iamVjdEZyb21LZXkiLCJqc29uIiwiaWR4Iiwic3JjIiwic3BsaWNlIiwidHJhbnNmb3JtU2VsZWN0Iiwic2VsZWN0T2JqZWN0Iiwib2JqZWN0cyIsInNlbGVjdFZhbHVlIiwidHJhbnNmb3JtRG9udFNlbGVjdCIsImRvbnRTZWxlY3RPYmplY3QiLCJkb250U2VsZWN0VmFsdWUiLCJjbGVhblJlc3VsdEF1dGhEYXRhIiwicGFzc3dvcmQiLCJhdXRoRGF0YSIsInByb3ZpZGVyIiwicmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCIsImNvbnN0cmFpbnQiLCJlcXVhbFRvT2JqZWN0IiwiaGFzRGlyZWN0Q29uc3RyYWludCIsImhhc09wZXJhdG9yQ29uc3RyYWludCIsIm9wdGlvbnMiLCJvcCIsImZpbmQiLCJmaWxlc0NvbnRyb2xsZXIiLCJleHBhbmRGaWxlc0luT2JqZWN0IiwiciIsImNvdW50Iiwic2tpcCIsImMiLCJnZXRPbmVTY2hlbWEiLCJzY2hlbWEiLCJpbmNsdWRlRmllbGRzIiwia2V5RmllbGRzIiwidHlwZSIsInBhdGhSZXNwb25zZSIsImluY2x1ZGVQYXRoIiwibmV3UmVzcG9uc2UiLCJoYXNBZnRlckZpbmRIb29rIiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYWZ0ZXJGaW5kIiwiYXBwbGljYXRpb25JZCIsInBpcGVsaW5lIiwiZGlzdGluY3QiLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJvYmplY3QiLCJ0b0pTT04iLCJwb2ludGVycyIsImZpbmRQb2ludGVycyIsInBvaW50ZXJzSGFzaCIsInBvaW50ZXIiLCJhZGQiLCJpbmNsdWRlUmVzdE9wdGlvbnMiLCJrZXlTZXQiLCJzZXQiLCJrZXlQYXRoIiwiaSIsInNpemUiLCJpbmNsdWRlUmVhZFByZWZlcmVuY2UiLCJxdWVyeVByb21pc2VzIiwib2JqZWN0SWRzIiwiJGluIiwiYWxsIiwicmVzcG9uc2VzIiwicmVwbGFjZSIsImluY2x1ZGVSZXNwb25zZSIsIm9iaiIsInNlc3Npb25Ub2tlbiIsInJlc3AiLCJyZXBsYWNlUG9pbnRlcnMiLCJhbnN3ZXIiLCJ4Iiwic3Vib2JqZWN0IiwibmV3c3ViIiwicm9vdCIsIml0ZW0iLCJzdWJrZXkiLCJvcGVyYXRpb24iLCJwcm9taXNlIiwicGFyZW50IiwiZ2V0U2VnbWVudCIsInJlamVjdCIsImNhcHR1cmVBc3luY0Z1bmMiLCJzdWJzZWdtZW50IiwiYWRkQW5ub3Rh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c0NvbnRlbnQiOlsiLy8gQW4gb2JqZWN0IHRoYXQgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYSAnZmluZCdcbi8vIG9wZXJhdGlvbiwgZW5jb2RlZCBpbiB0aGUgUkVTVCBBUEkgZm9ybWF0LlxuY29uc3QgQVdTWFJheSA9IHJlcXVpcmUoJ2F3cy14cmF5LXNkaycpO1xuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlO1xuY29uc3QgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG5jb25zdCB7IGNvbnRpbnVlV2hpbGUgfSA9IHJlcXVpcmUoJ3BhcnNlL2xpYi9ub2RlL3Byb21pc2VVdGlscycpO1xuY29uc3QgQWx3YXlzU2VsZWN0ZWRLZXlzID0gWydvYmplY3RJZCcsICdjcmVhdGVkQXQnLCAndXBkYXRlZEF0JywgJ0FDTCddO1xuLy8gcmVzdE9wdGlvbnMgY2FuIGluY2x1ZGU6XG4vLyAgIHNraXBcbi8vICAgbGltaXRcbi8vICAgb3JkZXJcbi8vICAgY291bnRcbi8vICAgaW5jbHVkZVxuLy8gICBrZXlzXG4vLyAgIGV4Y2x1ZGVLZXlzXG4vLyAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5XG4vLyAgIHJlYWRQcmVmZXJlbmNlXG4vLyAgIGluY2x1ZGVSZWFkUHJlZmVyZW5jZVxuLy8gICBzdWJxdWVyeVJlYWRQcmVmZXJlbmNlXG5mdW5jdGlvbiBSZXN0UXVlcnkoXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUgPSB7fSxcbiAgcmVzdE9wdGlvbnMgPSB7fSxcbiAgY2xpZW50U0RLXG4pIHtcbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLnJlc3RXaGVyZSA9IHJlc3RXaGVyZTtcbiAgdGhpcy5yZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zO1xuICB0aGlzLmNsaWVudFNESyA9IGNsaWVudFNESztcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG4gIHRoaXMuZmluZE9wdGlvbnMgPSB7fTtcblxuICBpZiAoIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PSAnX1Nlc3Npb24nKSB7XG4gICAgICBpZiAoIXRoaXMuYXV0aC51c2VyKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sXG4gICAgICAgICAgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRoaXMucmVzdFdoZXJlID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5yZXN0V2hlcmUsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdXNlcjoge1xuICAgICAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHRoaXMuZG9Db3VudCA9IGZhbHNlO1xuICB0aGlzLmluY2x1ZGVBbGwgPSBmYWxzZTtcblxuICAvLyBUaGUgZm9ybWF0IGZvciB0aGlzLmluY2x1ZGUgaXMgbm90IHRoZSBzYW1lIGFzIHRoZSBmb3JtYXQgZm9yIHRoZVxuICAvLyBpbmNsdWRlIG9wdGlvbiAtIGl0J3MgdGhlIHBhdGhzIHdlIHNob3VsZCBpbmNsdWRlLCBpbiBvcmRlcixcbiAgLy8gc3RvcmVkIGFzIGFycmF5cywgdGFraW5nIGludG8gYWNjb3VudCB0aGF0IHdlIG5lZWQgdG8gaW5jbHVkZSBmb29cbiAgLy8gYmVmb3JlIGluY2x1ZGluZyBmb28uYmFyLiBBbHNvIGl0IHNob3VsZCBkZWR1cGUuXG4gIC8vIEZvciBleGFtcGxlLCBwYXNzaW5nIGFuIGFyZyBvZiBpbmNsdWRlPWZvby5iYXIsZm9vLmJheiBjb3VsZCBsZWFkIHRvXG4gIC8vIHRoaXMuaW5jbHVkZSA9IFtbJ2ZvbyddLCBbJ2ZvbycsICdiYXonXSwgWydmb28nLCAnYmFyJ11dXG4gIHRoaXMuaW5jbHVkZSA9IFtdO1xuXG4gIC8vIElmIHdlIGhhdmUga2V5cywgd2UgcHJvYmFibHkgd2FudCB0byBmb3JjZSBzb21lIGluY2x1ZGVzIChuLTEgbGV2ZWwpXG4gIC8vIFNlZSBpc3N1ZTogaHR0cHM6Ly9naXRodWIuY29tL3BhcnNlLWNvbW11bml0eS9wYXJzZS1zZXJ2ZXIvaXNzdWVzLzMxODVcbiAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZXN0T3B0aW9ucywgJ2tleXMnKSkge1xuICAgIGNvbnN0IGtleXNGb3JJbmNsdWRlID0gcmVzdE9wdGlvbnMua2V5c1xuICAgICAgLnNwbGl0KCcsJylcbiAgICAgIC5maWx0ZXIoa2V5ID0+IHtcbiAgICAgICAgLy8gQXQgbGVhc3QgMiBjb21wb25lbnRzXG4gICAgICAgIHJldHVybiBrZXkuc3BsaXQoJy4nKS5sZW5ndGggPiAxO1xuICAgICAgfSlcbiAgICAgIC5tYXAoa2V5ID0+IHtcbiAgICAgICAgLy8gU2xpY2UgdGhlIGxhc3QgY29tcG9uZW50IChhLmIuYyAtPiBhLmIpXG4gICAgICAgIC8vIE90aGVyd2lzZSB3ZSdsbCBpbmNsdWRlIG9uZSBsZXZlbCB0b28gbXVjaC5cbiAgICAgICAgcmV0dXJuIGtleS5zbGljZSgwLCBrZXkubGFzdEluZGV4T2YoJy4nKSk7XG4gICAgICB9KVxuICAgICAgLmpvaW4oJywnKTtcblxuICAgIC8vIENvbmNhdCB0aGUgcG9zc2libHkgcHJlc2VudCBpbmNsdWRlIHN0cmluZyB3aXRoIHRoZSBvbmUgZnJvbSB0aGUga2V5c1xuICAgIC8vIERlZHVwIC8gc29ydGluZyBpcyBoYW5kbGUgaW4gJ2luY2x1ZGUnIGNhc2UuXG4gICAgaWYgKGtleXNGb3JJbmNsdWRlLmxlbmd0aCA+IDApIHtcbiAgICAgIGlmICghcmVzdE9wdGlvbnMuaW5jbHVkZSB8fCByZXN0T3B0aW9ucy5pbmNsdWRlLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgPSBrZXlzRm9ySW5jbHVkZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgKz0gJywnICsga2V5c0ZvckluY2x1ZGU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZm9yICh2YXIgb3B0aW9uIGluIHJlc3RPcHRpb25zKSB7XG4gICAgc3dpdGNoIChvcHRpb24pIHtcbiAgICAgIGNhc2UgJ2tleXMnOiB7XG4gICAgICAgIGNvbnN0IGtleXMgPSByZXN0T3B0aW9ucy5rZXlzLnNwbGl0KCcsJykuY29uY2F0KEFsd2F5c1NlbGVjdGVkS2V5cyk7XG4gICAgICAgIHRoaXMua2V5cyA9IEFycmF5LmZyb20obmV3IFNldChrZXlzKSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAnZXhjbHVkZUtleXMnOiB7XG4gICAgICAgIGNvbnN0IGV4Y2x1ZGUgPSByZXN0T3B0aW9ucy5leGNsdWRlS2V5c1xuICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgLmZpbHRlcihrID0+IEFsd2F5c1NlbGVjdGVkS2V5cy5pbmRleE9mKGspIDwgMCk7XG4gICAgICAgIHRoaXMuZXhjbHVkZUtleXMgPSBBcnJheS5mcm9tKG5ldyBTZXQoZXhjbHVkZSkpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJ2NvdW50JzpcbiAgICAgICAgdGhpcy5kb0NvdW50ID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdpbmNsdWRlQWxsJzpcbiAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdkaXN0aW5jdCc6XG4gICAgICBjYXNlICdwaXBlbGluZSc6XG4gICAgICBjYXNlICdza2lwJzpcbiAgICAgIGNhc2UgJ2xpbWl0JzpcbiAgICAgIGNhc2UgJ3JlYWRQcmVmZXJlbmNlJzpcbiAgICAgICAgdGhpcy5maW5kT3B0aW9uc1tvcHRpb25dID0gcmVzdE9wdGlvbnNbb3B0aW9uXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdvcmRlcic6XG4gICAgICAgIHZhciBmaWVsZHMgPSByZXN0T3B0aW9ucy5vcmRlci5zcGxpdCgnLCcpO1xuICAgICAgICB0aGlzLmZpbmRPcHRpb25zLnNvcnQgPSBmaWVsZHMucmVkdWNlKChzb3J0TWFwLCBmaWVsZCkgPT4ge1xuICAgICAgICAgIGZpZWxkID0gZmllbGQudHJpbSgpO1xuICAgICAgICAgIGlmIChmaWVsZCA9PT0gJyRzY29yZScpIHtcbiAgICAgICAgICAgIHNvcnRNYXAuc2NvcmUgPSB7ICRtZXRhOiAndGV4dFNjb3JlJyB9O1xuICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRbMF0gPT0gJy0nKSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkLnNsaWNlKDEpXSA9IC0xO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkXSA9IDE7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBzb3J0TWFwO1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZSc6IHtcbiAgICAgICAgY29uc3QgcGF0aHMgPSByZXN0T3B0aW9ucy5pbmNsdWRlLnNwbGl0KCcsJyk7XG4gICAgICAgIGlmIChwYXRocy5pbmNsdWRlcygnKicpKSB7XG4gICAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICAvLyBMb2FkIHRoZSBleGlzdGluZyBpbmNsdWRlcyAoZnJvbSBrZXlzKVxuICAgICAgICBjb25zdCBwYXRoU2V0ID0gcGF0aHMucmVkdWNlKChtZW1vLCBwYXRoKSA9PiB7XG4gICAgICAgICAgLy8gU3BsaXQgZWFjaCBwYXRocyBvbiAuIChhLmIuYyAtPiBbYSxiLGNdKVxuICAgICAgICAgIC8vIHJlZHVjZSB0byBjcmVhdGUgYWxsIHBhdGhzXG4gICAgICAgICAgLy8gKFthLGIsY10gLT4ge2E6IHRydWUsICdhLmInOiB0cnVlLCAnYS5iLmMnOiB0cnVlfSlcbiAgICAgICAgICByZXR1cm4gcGF0aC5zcGxpdCgnLicpLnJlZHVjZSgobWVtbywgcGF0aCwgaW5kZXgsIHBhcnRzKSA9PiB7XG4gICAgICAgICAgICBtZW1vW3BhcnRzLnNsaWNlKDAsIGluZGV4ICsgMSkuam9pbignLicpXSA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgICAgICB9LCBtZW1vKTtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIHRoaXMuaW5jbHVkZSA9IE9iamVjdC5rZXlzKHBhdGhTZXQpXG4gICAgICAgICAgLm1hcChzID0+IHtcbiAgICAgICAgICAgIHJldHVybiBzLnNwbGl0KCcuJyk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7IC8vIFNvcnQgYnkgbnVtYmVyIG9mIGNvbXBvbmVudHNcbiAgICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdyZWRpcmVjdENsYXNzTmFtZUZvcktleSc6XG4gICAgICAgIHRoaXMucmVkaXJlY3RLZXkgPSByZXN0T3B0aW9ucy5yZWRpcmVjdENsYXNzTmFtZUZvcktleTtcbiAgICAgICAgdGhpcy5yZWRpcmVjdENsYXNzTmFtZSA9IG51bGw7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgIGNhc2UgJ3N1YnF1ZXJ5UmVhZFByZWZlcmVuY2UnOlxuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCBvcHRpb246ICcgKyBvcHRpb25cbiAgICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyBhIHF1ZXJ5XG4vLyBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB0aGUgcmVzcG9uc2UgLSBhbiBvYmplY3Qgd2l0aCBvcHRpb25hbCBrZXlzXG4vLyAncmVzdWx0cycgYW5kICdjb3VudCcuXG4vLyBUT0RPOiBjb25zb2xpZGF0ZSB0aGUgcmVwbGFjZVggZnVuY3Rpb25zXG5SZXN0UXVlcnkucHJvdG90eXBlLmV4ZWN1dGUgPSBmdW5jdGlvbihleGVjdXRlT3B0aW9ucykge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnYnVpbGRSZXN0V2hlcmUnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5idWlsZFJlc3RXaGVyZSgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ2hhbmRsZUluY2x1ZGVBbGwnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5oYW5kbGVJbmNsdWRlQWxsKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnaGFuZGxlRXhjbHVkZUtleXMnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5oYW5kbGVFeGNsdWRlS2V5cygpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3J1bkZpbmQnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5ydW5GaW5kKGV4ZWN1dGVPcHRpb25zKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoJ3J1bkNvdW50JywgdGhpcy5jbGFzc05hbWUsIHRoaXMucnVuQ291bnQoKSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnaGFuZGxlSW5jbHVkZScsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmhhbmRsZUluY2x1ZGUoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdydW5BZnRlckZpbmRUcmlnZ2VyJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucnVuQWZ0ZXJGaW5kVHJpZ2dlcigpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVzcG9uc2U7XG4gICAgfSk7XG59O1xuXG5SZXN0UXVlcnkucHJvdG90eXBlLmVhY2ggPSBmdW5jdGlvbihjYWxsYmFjaykge1xuICBjb25zdCB7IGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCByZXN0V2hlcmUsIHJlc3RPcHRpb25zLCBjbGllbnRTREsgfSA9IHRoaXM7XG4gIC8vIGlmIHRoZSBsaW1pdCBpcyBzZXQsIHVzZSBpdFxuICByZXN0T3B0aW9ucy5saW1pdCA9IHJlc3RPcHRpb25zLmxpbWl0IHx8IDEwMDtcbiAgcmVzdE9wdGlvbnMub3JkZXIgPSAnb2JqZWN0SWQnO1xuICBsZXQgZmluaXNoZWQgPSBmYWxzZTtcblxuICByZXR1cm4gY29udGludWVXaGlsZShcbiAgICAoKSA9PiB7XG4gICAgICByZXR1cm4gIWZpbmlzaGVkO1xuICAgIH0sXG4gICAgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgY2xpZW50U0RLXG4gICAgICApO1xuICAgICAgY29uc3QgeyByZXN1bHRzIH0gPSBhd2FpdCBxdWVyeS5leGVjdXRlKCk7XG4gICAgICByZXN1bHRzLmZvckVhY2goY2FsbGJhY2spO1xuICAgICAgZmluaXNoZWQgPSByZXN1bHRzLmxlbmd0aCA8IHJlc3RPcHRpb25zLmxpbWl0O1xuICAgICAgaWYgKCFmaW5pc2hlZCkge1xuICAgICAgICByZXN0V2hlcmUub2JqZWN0SWQgPSBPYmplY3QuYXNzaWduKHt9LCByZXN0V2hlcmUub2JqZWN0SWQsIHtcbiAgICAgICAgICAkZ3Q6IHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXS5vYmplY3RJZCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICApO1xufTtcblxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5idWlsZFJlc3RXaGVyZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnZ2V0VXNlckFuZFJvbGVBQ0wnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3JlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5JyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWVGb3JLZXkoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICd2YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24nLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdyZXBsYWNlU2VsZWN0JyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucmVwbGFjZVNlbGVjdCgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3JlcGxhY2VEb250U2VsZWN0JyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdyZXBsYWNlSW5RdWVyeScsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLnJlcGxhY2VJblF1ZXJ5KClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAncmVwbGFjZU5vdEluUXVlcnknLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3JlcGxhY2VFcXVhbGl0eScsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLnJlcGxhY2VFcXVhbGl0eSgpXG4gICAgICApO1xuICAgIH0pO1xufTtcblxuLy8gVXNlcyB0aGUgQXV0aCBvYmplY3QgdG8gZ2V0IHRoZSBsaXN0IG9mIHJvbGVzLCBhZGRzIHRoZSB1c2VyIGlkXG5SZXN0UXVlcnkucHJvdG90eXBlLmdldFVzZXJBbmRSb2xlQUNMID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB0aGlzLmZpbmRPcHRpb25zLmFjbCA9IFsnKiddO1xuXG4gIGlmICh0aGlzLmF1dGgudXNlcikge1xuICAgIHJldHVybiB0aGlzLmF1dGguZ2V0VXNlclJvbGVzKCkudGhlbihyb2xlcyA9PiB7XG4gICAgICB0aGlzLmZpbmRPcHRpb25zLmFjbCA9IHRoaXMuZmluZE9wdGlvbnMuYWNsLmNvbmNhdChyb2xlcywgW1xuICAgICAgICB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgIF0pO1xuICAgICAgcmV0dXJuO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gQ2hhbmdlcyB0aGUgY2xhc3NOYW1lIGlmIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IGlzIHNldC5cbi8vIFJldHVybnMgYSBwcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMucmVkaXJlY3RLZXkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBXZSBuZWVkIHRvIGNoYW5nZSB0aGUgY2xhc3MgbmFtZSBiYXNlZCBvbiB0aGUgc2NoZW1hXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5yZWRpcmVjdENsYXNzTmFtZUZvcktleSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZWRpcmVjdEtleSlcbiAgICAudGhlbihuZXdDbGFzc05hbWUgPT4ge1xuICAgICAgdGhpcy5jbGFzc05hbWUgPSBuZXdDbGFzc05hbWU7XG4gICAgICB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lID0gbmV3Q2xhc3NOYW1lO1xuICAgIH0pO1xufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIGFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiBjb25maWcuXG5SZXN0UXVlcnkucHJvdG90eXBlLnZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAoXG4gICAgdGhpcy5jb25maWcuYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uID09PSBmYWxzZSAmJlxuICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICBTY2hlbWFDb250cm9sbGVyLnN5c3RlbUNsYXNzZXMuaW5kZXhPZih0aGlzLmNsYXNzTmFtZSkgPT09IC0xXG4gICkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmhhc0NsYXNzKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGhhc0NsYXNzID0+IHtcbiAgICAgICAgaWYgKGhhc0NsYXNzICE9PSB0cnVlKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgICdUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gYWNjZXNzICcgK1xuICAgICAgICAgICAgICAnbm9uLWV4aXN0ZW50IGNsYXNzOiAnICtcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWVcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybUluUXVlcnkoaW5RdWVyeU9iamVjdCwgY2xhc3NOYW1lLCByZXN1bHRzKSB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICB2YWx1ZXMucHVzaCh7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IHJlc3VsdC5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBkZWxldGUgaW5RdWVyeU9iamVjdFsnJGluUXVlcnknXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoaW5RdWVyeU9iamVjdFsnJGluJ10pKSB7XG4gICAgaW5RdWVyeU9iamVjdFsnJGluJ10gPSBpblF1ZXJ5T2JqZWN0WyckaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBpblF1ZXJ5T2JqZWN0WyckaW4nXSA9IHZhbHVlcztcbiAgfVxufVxuXG4vLyBSZXBsYWNlcyBhICRpblF1ZXJ5IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYW5cbi8vICRpblF1ZXJ5IGNsYXVzZS5cbi8vIFRoZSAkaW5RdWVyeSBjbGF1c2UgdHVybnMgaW50byBhbiAkaW4gd2l0aCB2YWx1ZXMgdGhhdCBhcmUganVzdFxuLy8gcG9pbnRlcnMgdG8gdGhlIG9iamVjdHMgcmV0dXJuZWQgaW4gdGhlIHN1YnF1ZXJ5LlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlSW5RdWVyeSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgaW5RdWVyeU9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJGluUXVlcnknKTtcbiAgaWYgKCFpblF1ZXJ5T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIGluUXVlcnkgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHdoZXJlIGFuZCBjbGFzc05hbWVcbiAgdmFyIGluUXVlcnlWYWx1ZSA9IGluUXVlcnlPYmplY3RbJyRpblF1ZXJ5J107XG4gIGlmICghaW5RdWVyeVZhbHVlLndoZXJlIHx8ICFpblF1ZXJ5VmFsdWUuY2xhc3NOYW1lKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICdpbXByb3BlciB1c2FnZSBvZiAkaW5RdWVyeSdcbiAgICApO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGluUXVlcnlWYWx1ZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgaW5RdWVyeVZhbHVlLmNsYXNzTmFtZSxcbiAgICBpblF1ZXJ5VmFsdWUud2hlcmUsXG4gICAgYWRkaXRpb25hbE9wdGlvbnNcbiAgKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1JblF1ZXJ5KGluUXVlcnlPYmplY3QsIHN1YnF1ZXJ5LmNsYXNzTmFtZSwgcmVzcG9uc2UucmVzdWx0cyk7XG4gICAgLy8gUmVjdXJzZSB0byByZXBlYXRcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlSW5RdWVyeSgpO1xuICB9KTtcbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybU5vdEluUXVlcnkobm90SW5RdWVyeU9iamVjdCwgY2xhc3NOYW1lLCByZXN1bHRzKSB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICB2YWx1ZXMucHVzaCh7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IHJlc3VsdC5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBkZWxldGUgbm90SW5RdWVyeU9iamVjdFsnJG5vdEluUXVlcnknXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkobm90SW5RdWVyeU9iamVjdFsnJG5pbiddKSkge1xuICAgIG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSA9IG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10gPSB2YWx1ZXM7XG4gIH1cbn1cblxuLy8gUmVwbGFjZXMgYSAkbm90SW5RdWVyeSBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFuXG4vLyAkbm90SW5RdWVyeSBjbGF1c2UuXG4vLyBUaGUgJG5vdEluUXVlcnkgY2xhdXNlIHR1cm5zIGludG8gYSAkbmluIHdpdGggdmFsdWVzIHRoYXQgYXJlIGp1c3Rcbi8vIHBvaW50ZXJzIHRvIHRoZSBvYmplY3RzIHJldHVybmVkIGluIHRoZSBzdWJxdWVyeS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZU5vdEluUXVlcnkgPSBmdW5jdGlvbigpIHtcbiAgdmFyIG5vdEluUXVlcnlPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRub3RJblF1ZXJ5Jyk7XG4gIGlmICghbm90SW5RdWVyeU9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBub3RJblF1ZXJ5IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSB3aGVyZSBhbmQgY2xhc3NOYW1lXG4gIHZhciBub3RJblF1ZXJ5VmFsdWUgPSBub3RJblF1ZXJ5T2JqZWN0Wyckbm90SW5RdWVyeSddO1xuICBpZiAoIW5vdEluUXVlcnlWYWx1ZS53aGVyZSB8fCAhbm90SW5RdWVyeVZhbHVlLmNsYXNzTmFtZSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJG5vdEluUXVlcnknXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBub3RJblF1ZXJ5VmFsdWUucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIHZhciBzdWJxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIG5vdEluUXVlcnlWYWx1ZS5jbGFzc05hbWUsXG4gICAgbm90SW5RdWVyeVZhbHVlLndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtTm90SW5RdWVyeShub3RJblF1ZXJ5T2JqZWN0LCBzdWJxdWVyeS5jbGFzc05hbWUsIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIFJlY3Vyc2UgdG8gcmVwZWF0XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZU5vdEluUXVlcnkoKTtcbiAgfSk7XG59O1xuXG4vLyBVc2VkIHRvIGdldCB0aGUgZGVlcGVzdCBvYmplY3QgZnJvbSBqc29uIHVzaW5nIGRvdCBub3RhdGlvbi5cbmNvbnN0IGdldERlZXBlc3RPYmplY3RGcm9tS2V5ID0gKGpzb24sIGtleSwgaWR4LCBzcmMpID0+IHtcbiAgaWYgKGtleSBpbiBqc29uKSB7XG4gICAgcmV0dXJuIGpzb25ba2V5XTtcbiAgfVxuICBzcmMuc3BsaWNlKDEpOyAvLyBFeGl0IEVhcmx5XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1TZWxlY3QgPSAoc2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZShnZXREZWVwZXN0T2JqZWN0RnJvbUtleSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIHNlbGVjdE9iamVjdFsnJHNlbGVjdCddO1xuICBpZiAoQXJyYXkuaXNBcnJheShzZWxlY3RPYmplY3RbJyRpbiddKSkge1xuICAgIHNlbGVjdE9iamVjdFsnJGluJ10gPSBzZWxlY3RPYmplY3RbJyRpbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIHNlbGVjdE9iamVjdFsnJGluJ10gPSB2YWx1ZXM7XG4gIH1cbn07XG5cbi8vIFJlcGxhY2VzIGEgJHNlbGVjdCBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFcbi8vICRzZWxlY3QgY2xhdXNlLlxuLy8gVGhlICRzZWxlY3QgY2xhdXNlIHR1cm5zIGludG8gYW4gJGluIHdpdGggdmFsdWVzIHNlbGVjdGVkIG91dCBvZlxuLy8gdGhlIHN1YnF1ZXJ5LlxuLy8gUmV0dXJucyBhIHBvc3NpYmxlLXByb21pc2UuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VTZWxlY3QgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHNlbGVjdE9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJHNlbGVjdCcpO1xuICBpZiAoIXNlbGVjdE9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBzZWxlY3QgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHF1ZXJ5IGFuZCBrZXlcbiAgdmFyIHNlbGVjdFZhbHVlID0gc2VsZWN0T2JqZWN0Wyckc2VsZWN0J107XG4gIC8vIGlPUyBTREsgZG9uJ3Qgc2VuZCB3aGVyZSBpZiBub3Qgc2V0LCBsZXQgaXQgcGFzc1xuICBpZiAoXG4gICAgIXNlbGVjdFZhbHVlLnF1ZXJ5IHx8XG4gICAgIXNlbGVjdFZhbHVlLmtleSB8fFxuICAgIHR5cGVvZiBzZWxlY3RWYWx1ZS5xdWVyeSAhPT0gJ29iamVjdCcgfHxcbiAgICAhc2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lIHx8XG4gICAgT2JqZWN0LmtleXMoc2VsZWN0VmFsdWUpLmxlbmd0aCAhPT0gMlxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRzZWxlY3QnXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBzZWxlY3RWYWx1ZS5xdWVyeS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgc2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIHNlbGVjdFZhbHVlLnF1ZXJ5LndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtU2VsZWN0KHNlbGVjdE9iamVjdCwgc2VsZWN0VmFsdWUua2V5LCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkc2VsZWN0IGNsYXVzZXNcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlU2VsZWN0KCk7XG4gIH0pO1xufTtcblxuY29uc3QgdHJhbnNmb3JtRG9udFNlbGVjdCA9IChkb250U2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZShnZXREZWVwZXN0T2JqZWN0RnJvbUtleSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBkb250U2VsZWN0T2JqZWN0WyckbmluJ10gPSBkb250U2VsZWN0T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgZG9udFNlbGVjdE9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59O1xuXG4vLyBSZXBsYWNlcyBhICRkb250U2VsZWN0IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYVxuLy8gJGRvbnRTZWxlY3QgY2xhdXNlLlxuLy8gVGhlICRkb250U2VsZWN0IGNsYXVzZSB0dXJucyBpbnRvIGFuICRuaW4gd2l0aCB2YWx1ZXMgc2VsZWN0ZWQgb3V0IG9mXG4vLyB0aGUgc3VicXVlcnkuXG4vLyBSZXR1cm5zIGEgcG9zc2libGUtcHJvbWlzZS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZURvbnRTZWxlY3QgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGRvbnRTZWxlY3RPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRkb250U2VsZWN0Jyk7XG4gIGlmICghZG9udFNlbGVjdE9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBkb250U2VsZWN0IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSBxdWVyeSBhbmQga2V5XG4gIHZhciBkb250U2VsZWN0VmFsdWUgPSBkb250U2VsZWN0T2JqZWN0WyckZG9udFNlbGVjdCddO1xuICBpZiAoXG4gICAgIWRvbnRTZWxlY3RWYWx1ZS5xdWVyeSB8fFxuICAgICFkb250U2VsZWN0VmFsdWUua2V5IHx8XG4gICAgdHlwZW9mIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeSAhPT0gJ29iamVjdCcgfHxcbiAgICAhZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSB8fFxuICAgIE9iamVjdC5rZXlzKGRvbnRTZWxlY3RWYWx1ZSkubGVuZ3RoICE9PSAyXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJGRvbnRTZWxlY3QnXG4gICAgKTtcbiAgfVxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICB2YXIgc3VicXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuYXV0aCxcbiAgICBkb250U2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS53aGVyZSxcbiAgICBhZGRpdGlvbmFsT3B0aW9uc1xuICApO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHRyYW5zZm9ybURvbnRTZWxlY3QoXG4gICAgICBkb250U2VsZWN0T2JqZWN0LFxuICAgICAgZG9udFNlbGVjdFZhbHVlLmtleSxcbiAgICAgIHJlc3BvbnNlLnJlc3VsdHNcbiAgICApO1xuICAgIC8vIEtlZXAgcmVwbGFjaW5nICRkb250U2VsZWN0IGNsYXVzZXNcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlRG9udFNlbGVjdCgpO1xuICB9KTtcbn07XG5cbmNvbnN0IGNsZWFuUmVzdWx0QXV0aERhdGEgPSBmdW5jdGlvbihyZXN1bHQpIHtcbiAgZGVsZXRlIHJlc3VsdC5wYXNzd29yZDtcbiAgaWYgKHJlc3VsdC5hdXRoRGF0YSkge1xuICAgIE9iamVjdC5rZXlzKHJlc3VsdC5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICBpZiAocmVzdWx0LmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICBkZWxldGUgcmVzdWx0LmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmIChPYmplY3Qua2V5cyhyZXN1bHQuYXV0aERhdGEpLmxlbmd0aCA9PSAwKSB7XG4gICAgICBkZWxldGUgcmVzdWx0LmF1dGhEYXRhO1xuICAgIH1cbiAgfVxufTtcblxuY29uc3QgcmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCA9IGNvbnN0cmFpbnQgPT4ge1xuICBpZiAodHlwZW9mIGNvbnN0cmFpbnQgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIGNvbnN0cmFpbnQ7XG4gIH1cbiAgY29uc3QgZXF1YWxUb09iamVjdCA9IHt9O1xuICBsZXQgaGFzRGlyZWN0Q29uc3RyYWludCA9IGZhbHNlO1xuICBsZXQgaGFzT3BlcmF0b3JDb25zdHJhaW50ID0gZmFsc2U7XG4gIGZvciAoY29uc3Qga2V5IGluIGNvbnN0cmFpbnQpIHtcbiAgICBpZiAoa2V5LmluZGV4T2YoJyQnKSAhPT0gMCkge1xuICAgICAgaGFzRGlyZWN0Q29uc3RyYWludCA9IHRydWU7XG4gICAgICBlcXVhbFRvT2JqZWN0W2tleV0gPSBjb25zdHJhaW50W2tleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGhhc09wZXJhdG9yQ29uc3RyYWludCA9IHRydWU7XG4gICAgfVxuICB9XG4gIGlmIChoYXNEaXJlY3RDb25zdHJhaW50ICYmIGhhc09wZXJhdG9yQ29uc3RyYWludCkge1xuICAgIGNvbnN0cmFpbnRbJyRlcSddID0gZXF1YWxUb09iamVjdDtcbiAgICBPYmplY3Qua2V5cyhlcXVhbFRvT2JqZWN0KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBkZWxldGUgY29uc3RyYWludFtrZXldO1xuICAgIH0pO1xuICB9XG4gIHJldHVybiBjb25zdHJhaW50O1xufTtcblxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlRXF1YWxpdHkgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHR5cGVvZiB0aGlzLnJlc3RXaGVyZSAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5yZXN0V2hlcmUpIHtcbiAgICB0aGlzLnJlc3RXaGVyZVtrZXldID0gcmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCh0aGlzLnJlc3RXaGVyZVtrZXldKTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZXRoZXIgaXQgd2FzIHN1Y2Nlc3NmdWwuXG4vLyBQb3B1bGF0ZXMgdGhpcy5yZXNwb25zZSB3aXRoIGFuIG9iamVjdCB0aGF0IG9ubHkgaGFzICdyZXN1bHRzJy5cblJlc3RRdWVyeS5wcm90b3R5cGUucnVuRmluZCA9IGZ1bmN0aW9uKG9wdGlvbnMgPSB7fSkge1xuICBpZiAodGhpcy5maW5kT3B0aW9ucy5saW1pdCA9PT0gMCkge1xuICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3VsdHM6IFtdIH07XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIGNvbnN0IGZpbmRPcHRpb25zID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5maW5kT3B0aW9ucyk7XG4gIGlmICh0aGlzLmtleXMpIHtcbiAgICBmaW5kT3B0aW9ucy5rZXlzID0gdGhpcy5rZXlzLm1hcChrZXkgPT4ge1xuICAgICAgcmV0dXJuIGtleS5zcGxpdCgnLicpWzBdO1xuICAgIH0pO1xuICB9XG4gIGlmIChvcHRpb25zLm9wKSB7XG4gICAgZmluZE9wdGlvbnMub3AgPSBvcHRpb25zLm9wO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJlc3RXaGVyZSwgZmluZE9wdGlvbnMsIHRoaXMuYXV0aClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgICBmb3IgKHZhciByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgICAgICAgIGNsZWFuUmVzdWx0QXV0aERhdGEocmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdCh0aGlzLmNvbmZpZywgcmVzdWx0cyk7XG5cbiAgICAgIGlmICh0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lKSB7XG4gICAgICAgIGZvciAodmFyIHIgb2YgcmVzdWx0cykge1xuICAgICAgICAgIHIuY2xhc3NOYW1lID0gdGhpcy5yZWRpcmVjdENsYXNzTmFtZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdGhpcy5yZXNwb25zZSA9IHsgcmVzdWx0czogcmVzdWx0cyB9O1xuICAgIH0pO1xufTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZXRoZXIgaXQgd2FzIHN1Y2Nlc3NmdWwuXG4vLyBQb3B1bGF0ZXMgdGhpcy5yZXNwb25zZS5jb3VudCB3aXRoIHRoZSBjb3VudFxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5ydW5Db3VudCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuZG9Db3VudCkge1xuICAgIHJldHVybjtcbiAgfVxuICB0aGlzLmZpbmRPcHRpb25zLmNvdW50ID0gdHJ1ZTtcbiAgZGVsZXRlIHRoaXMuZmluZE9wdGlvbnMuc2tpcDtcbiAgZGVsZXRlIHRoaXMuZmluZE9wdGlvbnMubGltaXQ7XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJlc3RXaGVyZSwgdGhpcy5maW5kT3B0aW9ucylcbiAgICAudGhlbihjID0+IHtcbiAgICAgIHRoaXMucmVzcG9uc2UuY291bnQgPSBjO1xuICAgIH0pO1xufTtcblxuLy8gQXVnbWVudHMgdGhpcy5yZXNwb25zZSB3aXRoIGFsbCBwb2ludGVycyBvbiBhbiBvYmplY3RcblJlc3RRdWVyeS5wcm90b3R5cGUuaGFuZGxlSW5jbHVkZUFsbCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuaW5jbHVkZUFsbCkge1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAubG9hZFNjaGVtYSgpXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYSh0aGlzLmNsYXNzTmFtZSkpXG4gICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgIGNvbnN0IGluY2x1ZGVGaWVsZHMgPSBbXTtcbiAgICAgIGNvbnN0IGtleUZpZWxkcyA9IFtdO1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBzY2hlbWEuZmllbGRzKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlICYmXG4gICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1BvaW50ZXInXG4gICAgICAgICkge1xuICAgICAgICAgIGluY2x1ZGVGaWVsZHMucHVzaChbZmllbGRdKTtcbiAgICAgICAgICBrZXlGaWVsZHMucHVzaChmaWVsZCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIEFkZCBmaWVsZHMgdG8gaW5jbHVkZSwga2V5cywgcmVtb3ZlIGR1cHNcbiAgICAgIHRoaXMuaW5jbHVkZSA9IFsuLi5uZXcgU2V0KFsuLi50aGlzLmluY2x1ZGUsIC4uLmluY2x1ZGVGaWVsZHNdKV07XG4gICAgICAvLyBpZiB0aGlzLmtleXMgbm90IHNldCwgdGhlbiBhbGwga2V5cyBhcmUgYWxyZWFkeSBpbmNsdWRlZFxuICAgICAgaWYgKHRoaXMua2V5cykge1xuICAgICAgICB0aGlzLmtleXMgPSBbLi4ubmV3IFNldChbLi4udGhpcy5rZXlzLCAuLi5rZXlGaWVsZHNdKV07XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG4vLyBVcGRhdGVzIHByb3BlcnR5IGB0aGlzLmtleXNgIHRvIGNvbnRhaW4gYWxsIGtleXMgYnV0IHRoZSBvbmVzIHVuc2VsZWN0ZWQuXG5SZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUV4Y2x1ZGVLZXlzID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5leGNsdWRlS2V5cykge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGhpcy5rZXlzKSB7XG4gICAgdGhpcy5rZXlzID0gdGhpcy5rZXlzLmZpbHRlcihrID0+ICF0aGlzLmV4Y2x1ZGVLZXlzLmluY2x1ZGVzKGspKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmxvYWRTY2hlbWEoKVxuICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEodGhpcy5jbGFzc05hbWUpKVxuICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICBjb25zdCBmaWVsZHMgPSBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKTtcbiAgICAgIHRoaXMua2V5cyA9IGZpZWxkcy5maWx0ZXIoayA9PiAhdGhpcy5leGNsdWRlS2V5cy5pbmNsdWRlcyhrKSk7XG4gICAgfSk7XG59O1xuXG4vLyBBdWdtZW50cyB0aGlzLnJlc3BvbnNlIHdpdGggZGF0YSBhdCB0aGUgcGF0aHMgcHJvdmlkZWQgaW4gdGhpcy5pbmNsdWRlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVJbmNsdWRlID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmluY2x1ZGUubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgcGF0aFJlc3BvbnNlID0gaW5jbHVkZVBhdGgoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIHRoaXMucmVzcG9uc2UsXG4gICAgdGhpcy5pbmNsdWRlWzBdLFxuICAgIHRoaXMucmVzdE9wdGlvbnNcbiAgKTtcbiAgaWYgKHBhdGhSZXNwb25zZS50aGVuKSB7XG4gICAgcmV0dXJuIHBhdGhSZXNwb25zZS50aGVuKG5ld1Jlc3BvbnNlID0+IHtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSBuZXdSZXNwb25zZTtcbiAgICAgIHRoaXMuaW5jbHVkZSA9IHRoaXMuaW5jbHVkZS5zbGljZSgxKTtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGUoKTtcbiAgICB9KTtcbiAgfSBlbHNlIGlmICh0aGlzLmluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgIHRoaXMuaW5jbHVkZSA9IHRoaXMuaW5jbHVkZS5zbGljZSgxKTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVJbmNsdWRlKCk7XG4gIH1cblxuICByZXR1cm4gcGF0aFJlc3BvbnNlO1xufTtcblxuLy9SZXR1cm5zIGEgcHJvbWlzZSBvZiBhIHByb2Nlc3NlZCBzZXQgb2YgcmVzdWx0c1xuUmVzdFF1ZXJ5LnByb3RvdHlwZS5ydW5BZnRlckZpbmRUcmlnZ2VyID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdhZnRlckZpbmQnIHRyaWdnZXIgZm9yIHRoaXMgY2xhc3MuXG4gIGNvbnN0IGhhc0FmdGVyRmluZEhvb2sgPSB0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyRmluZCxcbiAgICB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkXG4gICk7XG4gIGlmICghaGFzQWZ0ZXJGaW5kSG9vaykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBTa2lwIEFnZ3JlZ2F0ZSBhbmQgRGlzdGluY3QgUXVlcmllc1xuICBpZiAodGhpcy5maW5kT3B0aW9ucy5waXBlbGluZSB8fCB0aGlzLmZpbmRPcHRpb25zLmRpc3RpbmN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJ1biBhZnRlckZpbmQgdHJpZ2dlciBhbmQgc2V0IHRoZSBuZXcgcmVzdWx0c1xuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHMsXG4gICAgICB0aGlzLmNvbmZpZ1xuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIC8vIEVuc3VyZSB3ZSBwcm9wZXJseSBzZXQgdGhlIGNsYXNzTmFtZSBiYWNrXG4gICAgICBpZiAodGhpcy5yZWRpcmVjdENsYXNzTmFtZSkge1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHMgPSByZXN1bHRzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIGlmIChvYmplY3QgaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QpIHtcbiAgICAgICAgICAgIG9iamVjdCA9IG9iamVjdC50b0pTT04oKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0LmNsYXNzTmFtZSA9IHRoaXMucmVkaXJlY3RDbGFzc05hbWU7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdDtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHMgPSByZXN1bHRzO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuLy8gQWRkcyBpbmNsdWRlZCB2YWx1ZXMgdG8gdGhlIHJlc3BvbnNlLlxuLy8gUGF0aCBpcyBhIGxpc3Qgb2YgZmllbGQgbmFtZXMuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYW4gYXVnbWVudGVkIHJlc3BvbnNlLlxuZnVuY3Rpb24gaW5jbHVkZVBhdGgoY29uZmlnLCBhdXRoLCByZXNwb25zZSwgcGF0aCwgcmVzdE9wdGlvbnMgPSB7fSkge1xuICB2YXIgcG9pbnRlcnMgPSBmaW5kUG9pbnRlcnMocmVzcG9uc2UucmVzdWx0cywgcGF0aCk7XG4gIGlmIChwb2ludGVycy5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybiByZXNwb25zZTtcbiAgfVxuICBjb25zdCBwb2ludGVyc0hhc2ggPSB7fTtcbiAgZm9yICh2YXIgcG9pbnRlciBvZiBwb2ludGVycykge1xuICAgIGlmICghcG9pbnRlcikge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNsYXNzTmFtZSA9IHBvaW50ZXIuY2xhc3NOYW1lO1xuICAgIC8vIG9ubHkgaW5jbHVkZSB0aGUgZ29vZCBwb2ludGVyc1xuICAgIGlmIChjbGFzc05hbWUpIHtcbiAgICAgIHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdID0gcG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0gfHwgbmV3IFNldCgpO1xuICAgICAgcG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0uYWRkKHBvaW50ZXIub2JqZWN0SWQpO1xuICAgIH1cbiAgfVxuICBjb25zdCBpbmNsdWRlUmVzdE9wdGlvbnMgPSB7fTtcbiAgaWYgKHJlc3RPcHRpb25zLmtleXMpIHtcbiAgICBjb25zdCBrZXlzID0gbmV3IFNldChyZXN0T3B0aW9ucy5rZXlzLnNwbGl0KCcsJykpO1xuICAgIGNvbnN0IGtleVNldCA9IEFycmF5LmZyb20oa2V5cykucmVkdWNlKChzZXQsIGtleSkgPT4ge1xuICAgICAgY29uc3Qga2V5UGF0aCA9IGtleS5zcGxpdCgnLicpO1xuICAgICAgbGV0IGkgPSAwO1xuICAgICAgZm9yIChpOyBpIDwgcGF0aC5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAocGF0aFtpXSAhPSBrZXlQYXRoW2ldKSB7XG4gICAgICAgICAgcmV0dXJuIHNldDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGkgPCBrZXlQYXRoLmxlbmd0aCkge1xuICAgICAgICBzZXQuYWRkKGtleVBhdGhbaV0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHNldDtcbiAgICB9LCBuZXcgU2V0KCkpO1xuICAgIGlmIChrZXlTZXQuc2l6ZSA+IDApIHtcbiAgICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5rZXlzID0gQXJyYXkuZnJvbShrZXlTZXQpLmpvaW4oJywnKTtcbiAgICB9XG4gIH1cblxuICBpZiAocmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgaW5jbHVkZVJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UgPVxuICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgaW5jbHVkZVJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gcmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICBjb25zdCBxdWVyeVByb21pc2VzID0gT2JqZWN0LmtleXMocG9pbnRlcnNIYXNoKS5tYXAoY2xhc3NOYW1lID0+IHtcbiAgICBjb25zdCBvYmplY3RJZHMgPSBBcnJheS5mcm9tKHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdKTtcbiAgICBsZXQgd2hlcmU7XG4gICAgaWYgKG9iamVjdElkcy5sZW5ndGggPT09IDEpIHtcbiAgICAgIHdoZXJlID0geyBvYmplY3RJZDogb2JqZWN0SWRzWzBdIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIHdoZXJlID0geyBvYmplY3RJZDogeyAkaW46IG9iamVjdElkcyB9IH07XG4gICAgfVxuICAgIHZhciBxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgICBjb25maWcsXG4gICAgICBhdXRoLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgd2hlcmUsXG4gICAgICBpbmNsdWRlUmVzdE9wdGlvbnNcbiAgICApO1xuICAgIHJldHVybiBxdWVyeS5leGVjdXRlKHsgb3A6ICdnZXQnIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0cyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIEdldCB0aGUgb2JqZWN0cyBmb3IgYWxsIHRoZXNlIG9iamVjdCBpZHNcbiAgcmV0dXJuIFByb21pc2UuYWxsKHF1ZXJ5UHJvbWlzZXMpLnRoZW4ocmVzcG9uc2VzID0+IHtcbiAgICB2YXIgcmVwbGFjZSA9IHJlc3BvbnNlcy5yZWR1Y2UoKHJlcGxhY2UsIGluY2x1ZGVSZXNwb25zZSkgPT4ge1xuICAgICAgZm9yICh2YXIgb2JqIG9mIGluY2x1ZGVSZXNwb25zZS5yZXN1bHRzKSB7XG4gICAgICAgIG9iai5fX3R5cGUgPSAnT2JqZWN0JztcbiAgICAgICAgb2JqLmNsYXNzTmFtZSA9IGluY2x1ZGVSZXNwb25zZS5jbGFzc05hbWU7XG5cbiAgICAgICAgaWYgKG9iai5jbGFzc05hbWUgPT0gJ19Vc2VyJyAmJiAhYXV0aC5pc01hc3Rlcikge1xuICAgICAgICAgIGRlbGV0ZSBvYmouc2Vzc2lvblRva2VuO1xuICAgICAgICAgIGRlbGV0ZSBvYmouYXV0aERhdGE7XG4gICAgICAgIH1cbiAgICAgICAgcmVwbGFjZVtvYmoub2JqZWN0SWRdID0gb2JqO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlcGxhY2U7XG4gICAgfSwge30pO1xuXG4gICAgdmFyIHJlc3AgPSB7XG4gICAgICByZXN1bHRzOiByZXBsYWNlUG9pbnRlcnMocmVzcG9uc2UucmVzdWx0cywgcGF0aCwgcmVwbGFjZSksXG4gICAgfTtcbiAgICBpZiAocmVzcG9uc2UuY291bnQpIHtcbiAgICAgIHJlc3AuY291bnQgPSByZXNwb25zZS5jb3VudDtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3A7XG4gIH0pO1xufVxuXG4vLyBPYmplY3QgbWF5IGJlIGEgbGlzdCBvZiBSRVNULWZvcm1hdCBvYmplY3QgdG8gZmluZCBwb2ludGVycyBpbiwgb3Jcbi8vIGl0IG1heSBiZSBhIHNpbmdsZSBvYmplY3QuXG4vLyBJZiB0aGUgcGF0aCB5aWVsZHMgdGhpbmdzIHRoYXQgYXJlbid0IHBvaW50ZXJzLCB0aGlzIHRocm93cyBhbiBlcnJvci5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIFJldHVybnMgYSBsaXN0IG9mIHBvaW50ZXJzIGluIFJFU1QgZm9ybWF0LlxuZnVuY3Rpb24gZmluZFBvaW50ZXJzKG9iamVjdCwgcGF0aCkge1xuICBpZiAob2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICB2YXIgYW5zd2VyID0gW107XG4gICAgZm9yICh2YXIgeCBvZiBvYmplY3QpIHtcbiAgICAgIGFuc3dlciA9IGFuc3dlci5jb25jYXQoZmluZFBvaW50ZXJzKHgsIHBhdGgpKTtcbiAgICB9XG4gICAgcmV0dXJuIGFuc3dlcjtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKHBhdGgubGVuZ3RoID09IDApIHtcbiAgICBpZiAob2JqZWN0ID09PSBudWxsIHx8IG9iamVjdC5fX3R5cGUgPT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gW29iamVjdF07XG4gICAgfVxuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIHZhciBzdWJvYmplY3QgPSBvYmplY3RbcGF0aFswXV07XG4gIGlmICghc3Vib2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIHJldHVybiBmaW5kUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLy8gT2JqZWN0IG1heSBiZSBhIGxpc3Qgb2YgUkVTVC1mb3JtYXQgb2JqZWN0cyB0byByZXBsYWNlIHBvaW50ZXJzXG4vLyBpbiwgb3IgaXQgbWF5IGJlIGEgc2luZ2xlIG9iamVjdC5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIHJlcGxhY2UgaXMgYSBtYXAgZnJvbSBvYmplY3QgaWQgLT4gb2JqZWN0LlxuLy8gUmV0dXJucyBzb21ldGhpbmcgYW5hbG9nb3VzIHRvIG9iamVjdCwgYnV0IHdpdGggdGhlIGFwcHJvcHJpYXRlXG4vLyBwb2ludGVycyBpbmZsYXRlZC5cbmZ1bmN0aW9uIHJlcGxhY2VQb2ludGVycyhvYmplY3QsIHBhdGgsIHJlcGxhY2UpIHtcbiAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgcmV0dXJuIG9iamVjdFxuICAgICAgLm1hcChvYmogPT4gcmVwbGFjZVBvaW50ZXJzKG9iaiwgcGF0aCwgcmVwbGFjZSkpXG4gICAgICAuZmlsdGVyKG9iaiA9PiB0eXBlb2Ygb2JqICE9PSAndW5kZWZpbmVkJyk7XG4gIH1cblxuICBpZiAodHlwZW9mIG9iamVjdCAhPT0gJ29iamVjdCcgfHwgIW9iamVjdCkge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICBpZiAocGF0aC5sZW5ndGggPT09IDApIHtcbiAgICBpZiAob2JqZWN0ICYmIG9iamVjdC5fX3R5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgcmV0dXJuIHJlcGxhY2Vbb2JqZWN0Lm9iamVjdElkXTtcbiAgICB9XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIHZhciBzdWJvYmplY3QgPSBvYmplY3RbcGF0aFswXV07XG4gIGlmICghc3Vib2JqZWN0KSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuICB2YXIgbmV3c3ViID0gcmVwbGFjZVBvaW50ZXJzKHN1Ym9iamVjdCwgcGF0aC5zbGljZSgxKSwgcmVwbGFjZSk7XG4gIHZhciBhbnN3ZXIgPSB7fTtcbiAgZm9yICh2YXIga2V5IGluIG9iamVjdCkge1xuICAgIGlmIChrZXkgPT0gcGF0aFswXSkge1xuICAgICAgYW5zd2VyW2tleV0gPSBuZXdzdWI7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFuc3dlcltrZXldID0gb2JqZWN0W2tleV07XG4gICAgfVxuICB9XG4gIHJldHVybiBhbnN3ZXI7XG59XG5cbi8vIEZpbmRzIGEgc3Vib2JqZWN0IHRoYXQgaGFzIHRoZSBnaXZlbiBrZXksIGlmIHRoZXJlIGlzIG9uZS5cbi8vIFJldHVybnMgdW5kZWZpbmVkIG90aGVyd2lzZS5cbmZ1bmN0aW9uIGZpbmRPYmplY3RXaXRoS2V5KHJvb3QsIGtleSkge1xuICBpZiAodHlwZW9mIHJvb3QgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChyb290IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICBmb3IgKHZhciBpdGVtIG9mIHJvb3QpIHtcbiAgICAgIGNvbnN0IGFuc3dlciA9IGZpbmRPYmplY3RXaXRoS2V5KGl0ZW0sIGtleSk7XG4gICAgICBpZiAoYW5zd2VyKSB7XG4gICAgICAgIHJldHVybiBhbnN3ZXI7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGlmIChyb290ICYmIHJvb3Rba2V5XSkge1xuICAgIHJldHVybiByb290O1xuICB9XG4gIGZvciAodmFyIHN1YmtleSBpbiByb290KSB7XG4gICAgY29uc3QgYW5zd2VyID0gZmluZE9iamVjdFdpdGhLZXkocm9vdFtzdWJrZXldLCBrZXkpO1xuICAgIGlmIChhbnN3ZXIpIHtcbiAgICAgIHJldHVybiBhbnN3ZXI7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHRyYWNlUHJvbWlzZShvcGVyYXRpb24sIGNsYXNzTmFtZSwgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpKSB7XG4gIGNvbnN0IHBhcmVudCA9IEFXU1hSYXkuZ2V0U2VnbWVudCgpO1xuICBpZiAoIXBhcmVudCkge1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgQVdTWFJheS5jYXB0dXJlQXN5bmNGdW5jKFxuICAgICAgYFBhcnNlLVNlcnZlcl9SZXN0UXVlcnlfJHtvcGVyYXRpb259XyR7Y2xhc3NOYW1lfWAsXG4gICAgICBzdWJzZWdtZW50ID0+IHtcbiAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ0NvbnRyb2xsZXInLCAnUmVzdFF1ZXJ5Jyk7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdPcGVyYXRpb24nLCBvcGVyYXRpb24pO1xuICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ2xhc3NOYW1lJywgY2xhc3NOYW1lKTtcbiAgICAgICAgKHByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlID8gcHJvbWlzZSA6IFByb21pc2UucmVzb2x2ZShwcm9taXNlKSkudGhlbihcbiAgICAgICAgICBmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgICAgICAgIHJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5jbG9zZSgpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgZnVuY3Rpb24oZXJyb3IpIHtcbiAgICAgICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuY2xvc2UoZXJyb3IpO1xuICAgICAgICAgIH1cbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICApO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBSZXN0UXVlcnk7XG4iXX0=