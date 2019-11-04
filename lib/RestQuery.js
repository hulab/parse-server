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
    AWSXRay.captureAsyncFunc('Parse-Server', subsegment => {
      subsegment && subsegment.addAnnotation('Controller', 'RestQuery');
      subsegment && subsegment.addAnnotation('Operation', operation);
      subsegment && subsegment.addAnnotation('ClassName', className);
      promise.then(function (result) {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0UXVlcnkuanMiXSwibmFtZXMiOlsiQVdTWFJheSIsInJlcXVpcmUiLCJTY2hlbWFDb250cm9sbGVyIiwiUGFyc2UiLCJ0cmlnZ2VycyIsImNvbnRpbnVlV2hpbGUiLCJBbHdheXNTZWxlY3RlZEtleXMiLCJSZXN0UXVlcnkiLCJjb25maWciLCJhdXRoIiwiY2xhc3NOYW1lIiwicmVzdFdoZXJlIiwicmVzdE9wdGlvbnMiLCJjbGllbnRTREsiLCJyZXNwb25zZSIsImZpbmRPcHRpb25zIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiRXJyb3IiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCIkYW5kIiwiX190eXBlIiwib2JqZWN0SWQiLCJpZCIsImRvQ291bnQiLCJpbmNsdWRlQWxsIiwiaW5jbHVkZSIsIk9iamVjdCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImtleXNGb3JJbmNsdWRlIiwia2V5cyIsInNwbGl0IiwiZmlsdGVyIiwia2V5IiwibGVuZ3RoIiwibWFwIiwic2xpY2UiLCJsYXN0SW5kZXhPZiIsImpvaW4iLCJvcHRpb24iLCJjb25jYXQiLCJBcnJheSIsImZyb20iLCJTZXQiLCJleGNsdWRlIiwiZXhjbHVkZUtleXMiLCJrIiwiaW5kZXhPZiIsImZpZWxkcyIsIm9yZGVyIiwic29ydCIsInJlZHVjZSIsInNvcnRNYXAiLCJmaWVsZCIsInRyaW0iLCJzY29yZSIsIiRtZXRhIiwicGF0aHMiLCJpbmNsdWRlcyIsInBhdGhTZXQiLCJtZW1vIiwicGF0aCIsImluZGV4IiwicGFydHMiLCJzIiwiYSIsImIiLCJyZWRpcmVjdEtleSIsInJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IiwicmVkaXJlY3RDbGFzc05hbWUiLCJJTlZBTElEX0pTT04iLCJleGVjdXRlIiwiZXhlY3V0ZU9wdGlvbnMiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJ0cmFjZVByb21pc2UiLCJidWlsZFJlc3RXaGVyZSIsImhhbmRsZUluY2x1ZGVBbGwiLCJoYW5kbGVFeGNsdWRlS2V5cyIsInJ1bkZpbmQiLCJydW5Db3VudCIsImhhbmRsZUluY2x1ZGUiLCJydW5BZnRlckZpbmRUcmlnZ2VyIiwiZWFjaCIsImNhbGxiYWNrIiwibGltaXQiLCJmaW5pc2hlZCIsInF1ZXJ5IiwicmVzdWx0cyIsImZvckVhY2giLCJhc3NpZ24iLCIkZ3QiLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsInJlcGxhY2VTZWxlY3QiLCJyZXBsYWNlRG9udFNlbGVjdCIsInJlcGxhY2VJblF1ZXJ5IiwicmVwbGFjZU5vdEluUXVlcnkiLCJyZXBsYWNlRXF1YWxpdHkiLCJhY2wiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImRhdGFiYXNlIiwibmV3Q2xhc3NOYW1lIiwiYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwic3lzdGVtQ2xhc3NlcyIsImxvYWRTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwiaGFzQ2xhc3MiLCJPUEVSQVRJT05fRk9SQklEREVOIiwidHJhbnNmb3JtSW5RdWVyeSIsImluUXVlcnlPYmplY3QiLCJ2YWx1ZXMiLCJyZXN1bHQiLCJwdXNoIiwiaXNBcnJheSIsImZpbmRPYmplY3RXaXRoS2V5IiwiaW5RdWVyeVZhbHVlIiwid2hlcmUiLCJJTlZBTElEX1FVRVJZIiwiYWRkaXRpb25hbE9wdGlvbnMiLCJzdWJxdWVyeVJlYWRQcmVmZXJlbmNlIiwicmVhZFByZWZlcmVuY2UiLCJzdWJxdWVyeSIsInRyYW5zZm9ybU5vdEluUXVlcnkiLCJub3RJblF1ZXJ5T2JqZWN0Iiwibm90SW5RdWVyeVZhbHVlIiwiZ2V0RGVlcGVzdE9iamVjdEZyb21LZXkiLCJqc29uIiwiaWR4Iiwic3JjIiwic3BsaWNlIiwidHJhbnNmb3JtU2VsZWN0Iiwic2VsZWN0T2JqZWN0Iiwib2JqZWN0cyIsInNlbGVjdFZhbHVlIiwidHJhbnNmb3JtRG9udFNlbGVjdCIsImRvbnRTZWxlY3RPYmplY3QiLCJkb250U2VsZWN0VmFsdWUiLCJjbGVhblJlc3VsdEF1dGhEYXRhIiwicGFzc3dvcmQiLCJhdXRoRGF0YSIsInByb3ZpZGVyIiwicmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCIsImNvbnN0cmFpbnQiLCJlcXVhbFRvT2JqZWN0IiwiaGFzRGlyZWN0Q29uc3RyYWludCIsImhhc09wZXJhdG9yQ29uc3RyYWludCIsIm9wdGlvbnMiLCJvcCIsImZpbmQiLCJmaWxlc0NvbnRyb2xsZXIiLCJleHBhbmRGaWxlc0luT2JqZWN0IiwiciIsImNvdW50Iiwic2tpcCIsImMiLCJnZXRPbmVTY2hlbWEiLCJzY2hlbWEiLCJpbmNsdWRlRmllbGRzIiwia2V5RmllbGRzIiwidHlwZSIsInBhdGhSZXNwb25zZSIsImluY2x1ZGVQYXRoIiwibmV3UmVzcG9uc2UiLCJoYXNBZnRlckZpbmRIb29rIiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYWZ0ZXJGaW5kIiwiYXBwbGljYXRpb25JZCIsInBpcGVsaW5lIiwiZGlzdGluY3QiLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJvYmplY3QiLCJ0b0pTT04iLCJwb2ludGVycyIsImZpbmRQb2ludGVycyIsInBvaW50ZXJzSGFzaCIsInBvaW50ZXIiLCJhZGQiLCJpbmNsdWRlUmVzdE9wdGlvbnMiLCJrZXlTZXQiLCJzZXQiLCJrZXlQYXRoIiwiaSIsInNpemUiLCJpbmNsdWRlUmVhZFByZWZlcmVuY2UiLCJxdWVyeVByb21pc2VzIiwib2JqZWN0SWRzIiwiJGluIiwiYWxsIiwicmVzcG9uc2VzIiwicmVwbGFjZSIsImluY2x1ZGVSZXNwb25zZSIsIm9iaiIsInNlc3Npb25Ub2tlbiIsInJlc3AiLCJyZXBsYWNlUG9pbnRlcnMiLCJhbnN3ZXIiLCJ4Iiwic3Vib2JqZWN0IiwibmV3c3ViIiwicm9vdCIsIml0ZW0iLCJzdWJrZXkiLCJvcGVyYXRpb24iLCJwcm9taXNlIiwicGFyZW50IiwiZ2V0U2VnbWVudCIsInJlamVjdCIsImNhcHR1cmVBc3luY0Z1bmMiLCJzdWJzZWdtZW50IiwiYWRkQW5ub3Rh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YUFBWCxDQUF5QixXQUF6QixFQUFzQzdNLFNBQXRDLENBQWQ7QUFDQXVNLE1BQUFBLE9BQU8sQ0FBQ3BJLElBQVIsQ0FDRSxVQUFTdUMsTUFBVCxFQUFpQjtBQUNmeEMsUUFBQUEsT0FBTyxDQUFDd0MsTUFBRCxDQUFQO0FBQ0FrRyxRQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0UsS0FBWCxFQUFkO0FBQ0QsT0FKSCxFQUtFLFVBQVNDLEtBQVQsRUFBZ0I7QUFDZEwsUUFBQUEsTUFBTSxDQUFDSyxLQUFELENBQU47QUFDQUgsUUFBQUEsVUFBVSxJQUFJQSxVQUFVLENBQUNFLEtBQVgsQ0FBaUJDLEtBQWpCLENBQWQ7QUFDRCxPQVJIO0FBVUQsS0FkRDtBQWVELEdBaEJNLENBQVA7QUFpQkQ7O0FBRURDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnBOLFNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQW4gb2JqZWN0IHRoYXQgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYSAnZmluZCdcbi8vIG9wZXJhdGlvbiwgZW5jb2RlZCBpbiB0aGUgUkVTVCBBUEkgZm9ybWF0LlxuY29uc3QgQVdTWFJheSA9IHJlcXVpcmUoJ2F3cy14cmF5LXNkaycpO1xuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlO1xuY29uc3QgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG5jb25zdCB7IGNvbnRpbnVlV2hpbGUgfSA9IHJlcXVpcmUoJ3BhcnNlL2xpYi9ub2RlL3Byb21pc2VVdGlscycpO1xuY29uc3QgQWx3YXlzU2VsZWN0ZWRLZXlzID0gWydvYmplY3RJZCcsICdjcmVhdGVkQXQnLCAndXBkYXRlZEF0JywgJ0FDTCddO1xuLy8gcmVzdE9wdGlvbnMgY2FuIGluY2x1ZGU6XG4vLyAgIHNraXBcbi8vICAgbGltaXRcbi8vICAgb3JkZXJcbi8vICAgY291bnRcbi8vICAgaW5jbHVkZVxuLy8gICBrZXlzXG4vLyAgIGV4Y2x1ZGVLZXlzXG4vLyAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5XG4vLyAgIHJlYWRQcmVmZXJlbmNlXG4vLyAgIGluY2x1ZGVSZWFkUHJlZmVyZW5jZVxuLy8gICBzdWJxdWVyeVJlYWRQcmVmZXJlbmNlXG5mdW5jdGlvbiBSZXN0UXVlcnkoXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUgPSB7fSxcbiAgcmVzdE9wdGlvbnMgPSB7fSxcbiAgY2xpZW50U0RLXG4pIHtcbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLnJlc3RXaGVyZSA9IHJlc3RXaGVyZTtcbiAgdGhpcy5yZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zO1xuICB0aGlzLmNsaWVudFNESyA9IGNsaWVudFNESztcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG4gIHRoaXMuZmluZE9wdGlvbnMgPSB7fTtcblxuICBpZiAoIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PSAnX1Nlc3Npb24nKSB7XG4gICAgICBpZiAoIXRoaXMuYXV0aC51c2VyKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sXG4gICAgICAgICAgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRoaXMucmVzdFdoZXJlID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5yZXN0V2hlcmUsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdXNlcjoge1xuICAgICAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHRoaXMuZG9Db3VudCA9IGZhbHNlO1xuICB0aGlzLmluY2x1ZGVBbGwgPSBmYWxzZTtcblxuICAvLyBUaGUgZm9ybWF0IGZvciB0aGlzLmluY2x1ZGUgaXMgbm90IHRoZSBzYW1lIGFzIHRoZSBmb3JtYXQgZm9yIHRoZVxuICAvLyBpbmNsdWRlIG9wdGlvbiAtIGl0J3MgdGhlIHBhdGhzIHdlIHNob3VsZCBpbmNsdWRlLCBpbiBvcmRlcixcbiAgLy8gc3RvcmVkIGFzIGFycmF5cywgdGFraW5nIGludG8gYWNjb3VudCB0aGF0IHdlIG5lZWQgdG8gaW5jbHVkZSBmb29cbiAgLy8gYmVmb3JlIGluY2x1ZGluZyBmb28uYmFyLiBBbHNvIGl0IHNob3VsZCBkZWR1cGUuXG4gIC8vIEZvciBleGFtcGxlLCBwYXNzaW5nIGFuIGFyZyBvZiBpbmNsdWRlPWZvby5iYXIsZm9vLmJheiBjb3VsZCBsZWFkIHRvXG4gIC8vIHRoaXMuaW5jbHVkZSA9IFtbJ2ZvbyddLCBbJ2ZvbycsICdiYXonXSwgWydmb28nLCAnYmFyJ11dXG4gIHRoaXMuaW5jbHVkZSA9IFtdO1xuXG4gIC8vIElmIHdlIGhhdmUga2V5cywgd2UgcHJvYmFibHkgd2FudCB0byBmb3JjZSBzb21lIGluY2x1ZGVzIChuLTEgbGV2ZWwpXG4gIC8vIFNlZSBpc3N1ZTogaHR0cHM6Ly9naXRodWIuY29tL3BhcnNlLWNvbW11bml0eS9wYXJzZS1zZXJ2ZXIvaXNzdWVzLzMxODVcbiAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZXN0T3B0aW9ucywgJ2tleXMnKSkge1xuICAgIGNvbnN0IGtleXNGb3JJbmNsdWRlID0gcmVzdE9wdGlvbnMua2V5c1xuICAgICAgLnNwbGl0KCcsJylcbiAgICAgIC5maWx0ZXIoa2V5ID0+IHtcbiAgICAgICAgLy8gQXQgbGVhc3QgMiBjb21wb25lbnRzXG4gICAgICAgIHJldHVybiBrZXkuc3BsaXQoJy4nKS5sZW5ndGggPiAxO1xuICAgICAgfSlcbiAgICAgIC5tYXAoa2V5ID0+IHtcbiAgICAgICAgLy8gU2xpY2UgdGhlIGxhc3QgY29tcG9uZW50IChhLmIuYyAtPiBhLmIpXG4gICAgICAgIC8vIE90aGVyd2lzZSB3ZSdsbCBpbmNsdWRlIG9uZSBsZXZlbCB0b28gbXVjaC5cbiAgICAgICAgcmV0dXJuIGtleS5zbGljZSgwLCBrZXkubGFzdEluZGV4T2YoJy4nKSk7XG4gICAgICB9KVxuICAgICAgLmpvaW4oJywnKTtcblxuICAgIC8vIENvbmNhdCB0aGUgcG9zc2libHkgcHJlc2VudCBpbmNsdWRlIHN0cmluZyB3aXRoIHRoZSBvbmUgZnJvbSB0aGUga2V5c1xuICAgIC8vIERlZHVwIC8gc29ydGluZyBpcyBoYW5kbGUgaW4gJ2luY2x1ZGUnIGNhc2UuXG4gICAgaWYgKGtleXNGb3JJbmNsdWRlLmxlbmd0aCA+IDApIHtcbiAgICAgIGlmICghcmVzdE9wdGlvbnMuaW5jbHVkZSB8fCByZXN0T3B0aW9ucy5pbmNsdWRlLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgPSBrZXlzRm9ySW5jbHVkZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgKz0gJywnICsga2V5c0ZvckluY2x1ZGU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZm9yICh2YXIgb3B0aW9uIGluIHJlc3RPcHRpb25zKSB7XG4gICAgc3dpdGNoIChvcHRpb24pIHtcbiAgICAgIGNhc2UgJ2tleXMnOiB7XG4gICAgICAgIGNvbnN0IGtleXMgPSByZXN0T3B0aW9ucy5rZXlzLnNwbGl0KCcsJykuY29uY2F0KEFsd2F5c1NlbGVjdGVkS2V5cyk7XG4gICAgICAgIHRoaXMua2V5cyA9IEFycmF5LmZyb20obmV3IFNldChrZXlzKSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAnZXhjbHVkZUtleXMnOiB7XG4gICAgICAgIGNvbnN0IGV4Y2x1ZGUgPSByZXN0T3B0aW9ucy5leGNsdWRlS2V5c1xuICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgLmZpbHRlcihrID0+IEFsd2F5c1NlbGVjdGVkS2V5cy5pbmRleE9mKGspIDwgMCk7XG4gICAgICAgIHRoaXMuZXhjbHVkZUtleXMgPSBBcnJheS5mcm9tKG5ldyBTZXQoZXhjbHVkZSkpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJ2NvdW50JzpcbiAgICAgICAgdGhpcy5kb0NvdW50ID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdpbmNsdWRlQWxsJzpcbiAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdkaXN0aW5jdCc6XG4gICAgICBjYXNlICdwaXBlbGluZSc6XG4gICAgICBjYXNlICdza2lwJzpcbiAgICAgIGNhc2UgJ2xpbWl0JzpcbiAgICAgIGNhc2UgJ3JlYWRQcmVmZXJlbmNlJzpcbiAgICAgICAgdGhpcy5maW5kT3B0aW9uc1tvcHRpb25dID0gcmVzdE9wdGlvbnNbb3B0aW9uXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdvcmRlcic6XG4gICAgICAgIHZhciBmaWVsZHMgPSByZXN0T3B0aW9ucy5vcmRlci5zcGxpdCgnLCcpO1xuICAgICAgICB0aGlzLmZpbmRPcHRpb25zLnNvcnQgPSBmaWVsZHMucmVkdWNlKChzb3J0TWFwLCBmaWVsZCkgPT4ge1xuICAgICAgICAgIGZpZWxkID0gZmllbGQudHJpbSgpO1xuICAgICAgICAgIGlmIChmaWVsZCA9PT0gJyRzY29yZScpIHtcbiAgICAgICAgICAgIHNvcnRNYXAuc2NvcmUgPSB7ICRtZXRhOiAndGV4dFNjb3JlJyB9O1xuICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRbMF0gPT0gJy0nKSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkLnNsaWNlKDEpXSA9IC0xO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkXSA9IDE7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBzb3J0TWFwO1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZSc6IHtcbiAgICAgICAgY29uc3QgcGF0aHMgPSByZXN0T3B0aW9ucy5pbmNsdWRlLnNwbGl0KCcsJyk7XG4gICAgICAgIGlmIChwYXRocy5pbmNsdWRlcygnKicpKSB7XG4gICAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICAvLyBMb2FkIHRoZSBleGlzdGluZyBpbmNsdWRlcyAoZnJvbSBrZXlzKVxuICAgICAgICBjb25zdCBwYXRoU2V0ID0gcGF0aHMucmVkdWNlKChtZW1vLCBwYXRoKSA9PiB7XG4gICAgICAgICAgLy8gU3BsaXQgZWFjaCBwYXRocyBvbiAuIChhLmIuYyAtPiBbYSxiLGNdKVxuICAgICAgICAgIC8vIHJlZHVjZSB0byBjcmVhdGUgYWxsIHBhdGhzXG4gICAgICAgICAgLy8gKFthLGIsY10gLT4ge2E6IHRydWUsICdhLmInOiB0cnVlLCAnYS5iLmMnOiB0cnVlfSlcbiAgICAgICAgICByZXR1cm4gcGF0aC5zcGxpdCgnLicpLnJlZHVjZSgobWVtbywgcGF0aCwgaW5kZXgsIHBhcnRzKSA9PiB7XG4gICAgICAgICAgICBtZW1vW3BhcnRzLnNsaWNlKDAsIGluZGV4ICsgMSkuam9pbignLicpXSA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgICAgICB9LCBtZW1vKTtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIHRoaXMuaW5jbHVkZSA9IE9iamVjdC5rZXlzKHBhdGhTZXQpXG4gICAgICAgICAgLm1hcChzID0+IHtcbiAgICAgICAgICAgIHJldHVybiBzLnNwbGl0KCcuJyk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7IC8vIFNvcnQgYnkgbnVtYmVyIG9mIGNvbXBvbmVudHNcbiAgICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdyZWRpcmVjdENsYXNzTmFtZUZvcktleSc6XG4gICAgICAgIHRoaXMucmVkaXJlY3RLZXkgPSByZXN0T3B0aW9ucy5yZWRpcmVjdENsYXNzTmFtZUZvcktleTtcbiAgICAgICAgdGhpcy5yZWRpcmVjdENsYXNzTmFtZSA9IG51bGw7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgIGNhc2UgJ3N1YnF1ZXJ5UmVhZFByZWZlcmVuY2UnOlxuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCBvcHRpb246ICcgKyBvcHRpb25cbiAgICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyBhIHF1ZXJ5XG4vLyBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB0aGUgcmVzcG9uc2UgLSBhbiBvYmplY3Qgd2l0aCBvcHRpb25hbCBrZXlzXG4vLyAncmVzdWx0cycgYW5kICdjb3VudCcuXG4vLyBUT0RPOiBjb25zb2xpZGF0ZSB0aGUgcmVwbGFjZVggZnVuY3Rpb25zXG5SZXN0UXVlcnkucHJvdG90eXBlLmV4ZWN1dGUgPSBmdW5jdGlvbihleGVjdXRlT3B0aW9ucykge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKCdidWlsZFJlc3RXaGVyZScsIHRoaXMuY2xhc3NOYW1lLCB0aGlzLmJ1aWxkUmVzdFdoZXJlKCkpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZSgnaGFuZGxlSW5jbHVkZUFsbCcsIHRoaXMuY2xhc3NOYW1lLCB0aGlzLmhhbmRsZUluY2x1ZGVBbGwoKSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKCdoYW5kbGVFeGNsdWRlS2V5cycsIHRoaXMuY2xhc3NOYW1lLCB0aGlzLmhhbmRsZUV4Y2x1ZGVLZXlzKCkpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZSgncnVuRmluZCcsIHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJ1bkZpbmQoZXhlY3V0ZU9wdGlvbnMpKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoJ3J1bkNvdW50JywgdGhpcy5jbGFzc05hbWUsIHRoaXMucnVuQ291bnQoKSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKCdoYW5kbGVJbmNsdWRlJywgdGhpcy5jbGFzc05hbWUsIHRoaXMuaGFuZGxlSW5jbHVkZSgpKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoJ3J1bkFmdGVyRmluZFRyaWdnZXInLCB0aGlzLmNsYXNzTmFtZSwgdGhpcy5ydW5BZnRlckZpbmRUcmlnZ2VyKCkpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVzcG9uc2U7XG4gICAgfSk7XG59O1xuXG5SZXN0UXVlcnkucHJvdG90eXBlLmVhY2ggPSBmdW5jdGlvbihjYWxsYmFjaykge1xuICBjb25zdCB7IGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCByZXN0V2hlcmUsIHJlc3RPcHRpb25zLCBjbGllbnRTREsgfSA9IHRoaXM7XG4gIC8vIGlmIHRoZSBsaW1pdCBpcyBzZXQsIHVzZSBpdFxuICByZXN0T3B0aW9ucy5saW1pdCA9IHJlc3RPcHRpb25zLmxpbWl0IHx8IDEwMDtcbiAgcmVzdE9wdGlvbnMub3JkZXIgPSAnb2JqZWN0SWQnO1xuICBsZXQgZmluaXNoZWQgPSBmYWxzZTtcblxuICByZXR1cm4gY29udGludWVXaGlsZShcbiAgICAoKSA9PiB7XG4gICAgICByZXR1cm4gIWZpbmlzaGVkO1xuICAgIH0sXG4gICAgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgY2xpZW50U0RLXG4gICAgICApO1xuICAgICAgY29uc3QgeyByZXN1bHRzIH0gPSBhd2FpdCBxdWVyeS5leGVjdXRlKCk7XG4gICAgICByZXN1bHRzLmZvckVhY2goY2FsbGJhY2spO1xuICAgICAgZmluaXNoZWQgPSByZXN1bHRzLmxlbmd0aCA8IHJlc3RPcHRpb25zLmxpbWl0O1xuICAgICAgaWYgKCFmaW5pc2hlZCkge1xuICAgICAgICByZXN0V2hlcmUub2JqZWN0SWQgPSBPYmplY3QuYXNzaWduKHt9LCByZXN0V2hlcmUub2JqZWN0SWQsIHtcbiAgICAgICAgICAkZ3Q6IHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXS5vYmplY3RJZCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICApO1xufTtcblxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5idWlsZFJlc3RXaGVyZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVkaXJlY3RDbGFzc05hbWVGb3JLZXkoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZVNlbGVjdCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VJblF1ZXJ5KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZUVxdWFsaXR5KCk7XG4gICAgfSk7XG59O1xuXG4vLyBVc2VzIHRoZSBBdXRoIG9iamVjdCB0byBnZXQgdGhlIGxpc3Qgb2Ygcm9sZXMsIGFkZHMgdGhlIHVzZXIgaWRcblJlc3RRdWVyeS5wcm90b3R5cGUuZ2V0VXNlckFuZFJvbGVBQ0wgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMuZmluZE9wdGlvbnMuYWNsID0gWycqJ107XG5cbiAgaWYgKHRoaXMuYXV0aC51c2VyKSB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC5nZXRVc2VyUm9sZXMoKS50aGVuKHJvbGVzID0+IHtcbiAgICAgIHRoaXMuZmluZE9wdGlvbnMuYWNsID0gdGhpcy5maW5kT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbXG4gICAgICAgIHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgXSk7XG4gICAgICByZXR1cm47XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBDaGFuZ2VzIHRoZSBjbGFzc05hbWUgaWYgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXkgaXMgc2V0LlxuLy8gUmV0dXJucyBhIHByb21pc2UuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5ID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5yZWRpcmVjdEtleSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIFdlIG5lZWQgdG8gY2hhbmdlIHRoZSBjbGFzcyBuYW1lIGJhc2VkIG9uIHRoZSBzY2hlbWFcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5KHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJlZGlyZWN0S2V5KVxuICAgIC50aGVuKG5ld0NsYXNzTmFtZSA9PiB7XG4gICAgICB0aGlzLmNsYXNzTmFtZSA9IG5ld0NsYXNzTmFtZTtcbiAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWUgPSBuZXdDbGFzc05hbWU7XG4gICAgfSk7XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIGNvbmZpZy5cblJlc3RRdWVyeS5wcm90b3R5cGUudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3MgJyArXG4gICAgICAgICAgICAgICdub24tZXhpc3RlbnQgY2xhc3M6ICcgK1xuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gdHJhbnNmb3JtSW5RdWVyeShpblF1ZXJ5T2JqZWN0LCBjbGFzc05hbWUsIHJlc3VsdHMpIHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgIHZhbHVlcy5wdXNoKHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiBjbGFzc05hbWUsXG4gICAgICBvYmplY3RJZDogcmVzdWx0Lm9iamVjdElkLFxuICAgIH0pO1xuICB9XG4gIGRlbGV0ZSBpblF1ZXJ5T2JqZWN0WyckaW5RdWVyeSddO1xuICBpZiAoQXJyYXkuaXNBcnJheShpblF1ZXJ5T2JqZWN0WyckaW4nXSkpIHtcbiAgICBpblF1ZXJ5T2JqZWN0WyckaW4nXSA9IGluUXVlcnlPYmplY3RbJyRpbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIGluUXVlcnlPYmplY3RbJyRpbiddID0gdmFsdWVzO1xuICB9XG59XG5cbi8vIFJlcGxhY2VzIGEgJGluUXVlcnkgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhblxuLy8gJGluUXVlcnkgY2xhdXNlLlxuLy8gVGhlICRpblF1ZXJ5IGNsYXVzZSB0dXJucyBpbnRvIGFuICRpbiB3aXRoIHZhbHVlcyB0aGF0IGFyZSBqdXN0XG4vLyBwb2ludGVycyB0byB0aGUgb2JqZWN0cyByZXR1cm5lZCBpbiB0aGUgc3VicXVlcnkuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VJblF1ZXJ5ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBpblF1ZXJ5T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckaW5RdWVyeScpO1xuICBpZiAoIWluUXVlcnlPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgaW5RdWVyeSB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gd2hlcmUgYW5kIGNsYXNzTmFtZVxuICB2YXIgaW5RdWVyeVZhbHVlID0gaW5RdWVyeU9iamVjdFsnJGluUXVlcnknXTtcbiAgaWYgKCFpblF1ZXJ5VmFsdWUud2hlcmUgfHwgIWluUXVlcnlWYWx1ZS5jbGFzc05hbWUpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRpblF1ZXJ5J1xuICAgICk7XG4gIH1cblxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogaW5RdWVyeVZhbHVlLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICB2YXIgc3VicXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuYXV0aCxcbiAgICBpblF1ZXJ5VmFsdWUuY2xhc3NOYW1lLFxuICAgIGluUXVlcnlWYWx1ZS53aGVyZSxcbiAgICBhZGRpdGlvbmFsT3B0aW9uc1xuICApO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHRyYW5zZm9ybUluUXVlcnkoaW5RdWVyeU9iamVjdCwgc3VicXVlcnkuY2xhc3NOYW1lLCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBSZWN1cnNlIHRvIHJlcGVhdFxuICAgIHJldHVybiB0aGlzLnJlcGxhY2VJblF1ZXJ5KCk7XG4gIH0pO1xufTtcblxuZnVuY3Rpb24gdHJhbnNmb3JtTm90SW5RdWVyeShub3RJblF1ZXJ5T2JqZWN0LCBjbGFzc05hbWUsIHJlc3VsdHMpIHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgIHZhbHVlcy5wdXNoKHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiBjbGFzc05hbWUsXG4gICAgICBvYmplY3RJZDogcmVzdWx0Lm9iamVjdElkLFxuICAgIH0pO1xuICB9XG4gIGRlbGV0ZSBub3RJblF1ZXJ5T2JqZWN0Wyckbm90SW5RdWVyeSddO1xuICBpZiAoQXJyYXkuaXNBcnJheShub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10pKSB7XG4gICAgbm90SW5RdWVyeU9iamVjdFsnJG5pbiddID0gbm90SW5RdWVyeU9iamVjdFsnJG5pbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSA9IHZhbHVlcztcbiAgfVxufVxuXG4vLyBSZXBsYWNlcyBhICRub3RJblF1ZXJ5IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYW5cbi8vICRub3RJblF1ZXJ5IGNsYXVzZS5cbi8vIFRoZSAkbm90SW5RdWVyeSBjbGF1c2UgdHVybnMgaW50byBhICRuaW4gd2l0aCB2YWx1ZXMgdGhhdCBhcmUganVzdFxuLy8gcG9pbnRlcnMgdG8gdGhlIG9iamVjdHMgcmV0dXJuZWQgaW4gdGhlIHN1YnF1ZXJ5LlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlTm90SW5RdWVyeSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgbm90SW5RdWVyeU9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJG5vdEluUXVlcnknKTtcbiAgaWYgKCFub3RJblF1ZXJ5T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIG5vdEluUXVlcnkgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHdoZXJlIGFuZCBjbGFzc05hbWVcbiAgdmFyIG5vdEluUXVlcnlWYWx1ZSA9IG5vdEluUXVlcnlPYmplY3RbJyRub3RJblF1ZXJ5J107XG4gIGlmICghbm90SW5RdWVyeVZhbHVlLndoZXJlIHx8ICFub3RJblF1ZXJ5VmFsdWUuY2xhc3NOYW1lKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICdpbXByb3BlciB1c2FnZSBvZiAkbm90SW5RdWVyeSdcbiAgICApO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IG5vdEluUXVlcnlWYWx1ZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgbm90SW5RdWVyeVZhbHVlLmNsYXNzTmFtZSxcbiAgICBub3RJblF1ZXJ5VmFsdWUud2hlcmUsXG4gICAgYWRkaXRpb25hbE9wdGlvbnNcbiAgKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1Ob3RJblF1ZXJ5KG5vdEluUXVlcnlPYmplY3QsIHN1YnF1ZXJ5LmNsYXNzTmFtZSwgcmVzcG9uc2UucmVzdWx0cyk7XG4gICAgLy8gUmVjdXJzZSB0byByZXBlYXRcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpO1xuICB9KTtcbn07XG5cbi8vIFVzZWQgdG8gZ2V0IHRoZSBkZWVwZXN0IG9iamVjdCBmcm9tIGpzb24gdXNpbmcgZG90IG5vdGF0aW9uLlxuY29uc3QgZ2V0RGVlcGVzdE9iamVjdEZyb21LZXkgPSAoanNvbiwga2V5LCBpZHgsIHNyYykgPT4ge1xuICBpZiAoa2V5IGluIGpzb24pIHtcbiAgICByZXR1cm4ganNvbltrZXldO1xuICB9XG4gIHNyYy5zcGxpY2UoMSk7IC8vIEV4aXQgRWFybHlcbn07XG5cbmNvbnN0IHRyYW5zZm9ybVNlbGVjdCA9IChzZWxlY3RPYmplY3QsIGtleSwgb2JqZWN0cykgPT4ge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiBvYmplY3RzKSB7XG4gICAgdmFsdWVzLnB1c2goa2V5LnNwbGl0KCcuJykucmVkdWNlKGdldERlZXBlc3RPYmplY3RGcm9tS2V5LCByZXN1bHQpKTtcbiAgfVxuICBkZWxldGUgc2VsZWN0T2JqZWN0Wyckc2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdE9iamVjdFsnJGluJ10pKSB7XG4gICAgc2VsZWN0T2JqZWN0WyckaW4nXSA9IHNlbGVjdE9iamVjdFsnJGluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgc2VsZWN0T2JqZWN0WyckaW4nXSA9IHZhbHVlcztcbiAgfVxufTtcblxuLy8gUmVwbGFjZXMgYSAkc2VsZWN0IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYVxuLy8gJHNlbGVjdCBjbGF1c2UuXG4vLyBUaGUgJHNlbGVjdCBjbGF1c2UgdHVybnMgaW50byBhbiAkaW4gd2l0aCB2YWx1ZXMgc2VsZWN0ZWQgb3V0IG9mXG4vLyB0aGUgc3VicXVlcnkuXG4vLyBSZXR1cm5zIGEgcG9zc2libGUtcHJvbWlzZS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZVNlbGVjdCA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc2VsZWN0T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckc2VsZWN0Jyk7XG4gIGlmICghc2VsZWN0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIHNlbGVjdCB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gcXVlcnkgYW5kIGtleVxuICB2YXIgc2VsZWN0VmFsdWUgPSBzZWxlY3RPYmplY3RbJyRzZWxlY3QnXTtcbiAgLy8gaU9TIFNESyBkb24ndCBzZW5kIHdoZXJlIGlmIG5vdCBzZXQsIGxldCBpdCBwYXNzXG4gIGlmIChcbiAgICAhc2VsZWN0VmFsdWUucXVlcnkgfHxcbiAgICAhc2VsZWN0VmFsdWUua2V5IHx8XG4gICAgdHlwZW9mIHNlbGVjdFZhbHVlLnF1ZXJ5ICE9PSAnb2JqZWN0JyB8fFxuICAgICFzZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUgfHxcbiAgICBPYmplY3Qua2V5cyhzZWxlY3RWYWx1ZSkubGVuZ3RoICE9PSAyXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJHNlbGVjdCdcbiAgICApO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IHNlbGVjdFZhbHVlLnF1ZXJ5LnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICB2YXIgc3VicXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuYXV0aCxcbiAgICBzZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUsXG4gICAgc2VsZWN0VmFsdWUucXVlcnkud2hlcmUsXG4gICAgYWRkaXRpb25hbE9wdGlvbnNcbiAgKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1TZWxlY3Qoc2VsZWN0T2JqZWN0LCBzZWxlY3RWYWx1ZS5rZXksIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIEtlZXAgcmVwbGFjaW5nICRzZWxlY3QgY2xhdXNlc1xuICAgIHJldHVybiB0aGlzLnJlcGxhY2VTZWxlY3QoKTtcbiAgfSk7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1Eb250U2VsZWN0ID0gKGRvbnRTZWxlY3RPYmplY3QsIGtleSwgb2JqZWN0cykgPT4ge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiBvYmplY3RzKSB7XG4gICAgdmFsdWVzLnB1c2goa2V5LnNwbGl0KCcuJykucmVkdWNlKGdldERlZXBlc3RPYmplY3RGcm9tS2V5LCByZXN1bHQpKTtcbiAgfVxuICBkZWxldGUgZG9udFNlbGVjdE9iamVjdFsnJGRvbnRTZWxlY3QnXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoZG9udFNlbGVjdE9iamVjdFsnJG5pbiddKSkge1xuICAgIGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSA9IGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBkb250U2VsZWN0T2JqZWN0WyckbmluJ10gPSB2YWx1ZXM7XG4gIH1cbn07XG5cbi8vIFJlcGxhY2VzIGEgJGRvbnRTZWxlY3QgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhXG4vLyAkZG9udFNlbGVjdCBjbGF1c2UuXG4vLyBUaGUgJGRvbnRTZWxlY3QgY2xhdXNlIHR1cm5zIGludG8gYW4gJG5pbiB3aXRoIHZhbHVlcyBzZWxlY3RlZCBvdXQgb2Zcbi8vIHRoZSBzdWJxdWVyeS5cbi8vIFJldHVybnMgYSBwb3NzaWJsZS1wcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlRG9udFNlbGVjdCA9IGZ1bmN0aW9uKCkge1xuICB2YXIgZG9udFNlbGVjdE9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJGRvbnRTZWxlY3QnKTtcbiAgaWYgKCFkb250U2VsZWN0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIGRvbnRTZWxlY3QgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHF1ZXJ5IGFuZCBrZXlcbiAgdmFyIGRvbnRTZWxlY3RWYWx1ZSA9IGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmIChcbiAgICAhZG9udFNlbGVjdFZhbHVlLnF1ZXJ5IHx8XG4gICAgIWRvbnRTZWxlY3RWYWx1ZS5rZXkgfHxcbiAgICB0eXBlb2YgZG9udFNlbGVjdFZhbHVlLnF1ZXJ5ICE9PSAnb2JqZWN0JyB8fFxuICAgICFkb250U2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lIHx8XG4gICAgT2JqZWN0LmtleXMoZG9udFNlbGVjdFZhbHVlKS5sZW5ndGggIT09IDJcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICdpbXByb3BlciB1c2FnZSBvZiAkZG9udFNlbGVjdCdcbiAgICApO1xuICB9XG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBkb250U2VsZWN0VmFsdWUucXVlcnkucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIHZhciBzdWJxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUsXG4gICAgZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtRG9udFNlbGVjdChcbiAgICAgIGRvbnRTZWxlY3RPYmplY3QsXG4gICAgICBkb250U2VsZWN0VmFsdWUua2V5LFxuICAgICAgcmVzcG9uc2UucmVzdWx0c1xuICAgICk7XG4gICAgLy8gS2VlcCByZXBsYWNpbmcgJGRvbnRTZWxlY3QgY2xhdXNlc1xuICAgIHJldHVybiB0aGlzLnJlcGxhY2VEb250U2VsZWN0KCk7XG4gIH0pO1xufTtcblxuY29uc3QgY2xlYW5SZXN1bHRBdXRoRGF0YSA9IGZ1bmN0aW9uKHJlc3VsdCkge1xuICBkZWxldGUgcmVzdWx0LnBhc3N3b3JkO1xuICBpZiAocmVzdWx0LmF1dGhEYXRhKSB7XG4gICAgT2JqZWN0LmtleXMocmVzdWx0LmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgIGlmIChyZXN1bHQuYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgIGRlbGV0ZSByZXN1bHQuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKE9iamVjdC5rZXlzKHJlc3VsdC5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgIGRlbGV0ZSByZXN1bHQuYXV0aERhdGE7XG4gICAgfVxuICB9XG59O1xuXG5jb25zdCByZXBsYWNlRXF1YWxpdHlDb25zdHJhaW50ID0gY29uc3RyYWludCA9PiB7XG4gIGlmICh0eXBlb2YgY29uc3RyYWludCAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm4gY29uc3RyYWludDtcbiAgfVxuICBjb25zdCBlcXVhbFRvT2JqZWN0ID0ge307XG4gIGxldCBoYXNEaXJlY3RDb25zdHJhaW50ID0gZmFsc2U7XG4gIGxldCBoYXNPcGVyYXRvckNvbnN0cmFpbnQgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBrZXkgaW4gY29uc3RyYWludCkge1xuICAgIGlmIChrZXkuaW5kZXhPZignJCcpICE9PSAwKSB7XG4gICAgICBoYXNEaXJlY3RDb25zdHJhaW50ID0gdHJ1ZTtcbiAgICAgIGVxdWFsVG9PYmplY3Rba2V5XSA9IGNvbnN0cmFpbnRba2V5XTtcbiAgICB9IGVsc2Uge1xuICAgICAgaGFzT3BlcmF0b3JDb25zdHJhaW50ID0gdHJ1ZTtcbiAgICB9XG4gIH1cbiAgaWYgKGhhc0RpcmVjdENvbnN0cmFpbnQgJiYgaGFzT3BlcmF0b3JDb25zdHJhaW50KSB7XG4gICAgY29uc3RyYWludFsnJGVxJ10gPSBlcXVhbFRvT2JqZWN0O1xuICAgIE9iamVjdC5rZXlzKGVxdWFsVG9PYmplY3QpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgIGRlbGV0ZSBjb25zdHJhaW50W2tleV07XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGNvbnN0cmFpbnQ7XG59O1xuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VFcXVhbGl0eSA9IGZ1bmN0aW9uKCkge1xuICBpZiAodHlwZW9mIHRoaXMucmVzdFdoZXJlICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBpbiB0aGlzLnJlc3RXaGVyZSkge1xuICAgIHRoaXMucmVzdFdoZXJlW2tleV0gPSByZXBsYWNlRXF1YWxpdHlDb25zdHJhaW50KHRoaXMucmVzdFdoZXJlW2tleV0pO1xuICB9XG59O1xuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hldGhlciBpdCB3YXMgc3VjY2Vzc2Z1bC5cbi8vIFBvcHVsYXRlcyB0aGlzLnJlc3BvbnNlIHdpdGggYW4gb2JqZWN0IHRoYXQgb25seSBoYXMgJ3Jlc3VsdHMnLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5ydW5GaW5kID0gZnVuY3Rpb24ob3B0aW9ucyA9IHt9KSB7XG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLmxpbWl0ID09PSAwKSB7XG4gICAgdGhpcy5yZXNwb25zZSA9IHsgcmVzdWx0czogW10gfTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgY29uc3QgZmluZE9wdGlvbnMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLmZpbmRPcHRpb25zKTtcbiAgaWYgKHRoaXMua2V5cykge1xuICAgIGZpbmRPcHRpb25zLmtleXMgPSB0aGlzLmtleXMubWFwKGtleSA9PiB7XG4gICAgICByZXR1cm4ga2V5LnNwbGl0KCcuJylbMF07XG4gICAgfSk7XG4gIH1cbiAgaWYgKG9wdGlvbnMub3ApIHtcbiAgICBmaW5kT3B0aW9ucy5vcCA9IG9wdGlvbnMub3A7XG4gIH1cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQodGhpcy5jbGFzc05hbWUsIHRoaXMucmVzdFdoZXJlLCBmaW5kT3B0aW9ucywgdGhpcy5hdXRoKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgICAgICAgY2xlYW5SZXN1bHRBdXRoRGF0YShyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCByZXN1bHRzKTtcblxuICAgICAgaWYgKHRoaXMucmVkaXJlY3RDbGFzc05hbWUpIHtcbiAgICAgICAgZm9yICh2YXIgciBvZiByZXN1bHRzKSB7XG4gICAgICAgICAgci5jbGFzc05hbWUgPSB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0aGlzLnJlc3BvbnNlID0geyByZXN1bHRzOiByZXN1bHRzIH07XG4gICAgfSk7XG59O1xuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hldGhlciBpdCB3YXMgc3VjY2Vzc2Z1bC5cbi8vIFBvcHVsYXRlcyB0aGlzLnJlc3BvbnNlLmNvdW50IHdpdGggdGhlIGNvdW50XG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkNvdW50ID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5kb0NvdW50KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuZmluZE9wdGlvbnMuY291bnQgPSB0cnVlO1xuICBkZWxldGUgdGhpcy5maW5kT3B0aW9ucy5za2lwO1xuICBkZWxldGUgdGhpcy5maW5kT3B0aW9ucy5saW1pdDtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQodGhpcy5jbGFzc05hbWUsIHRoaXMucmVzdFdoZXJlLCB0aGlzLmZpbmRPcHRpb25zKVxuICAgIC50aGVuKGMgPT4ge1xuICAgICAgdGhpcy5yZXNwb25zZS5jb3VudCA9IGM7XG4gICAgfSk7XG59O1xuXG4vLyBBdWdtZW50cyB0aGlzLnJlc3BvbnNlIHdpdGggYWxsIHBvaW50ZXJzIG9uIGFuIG9iamVjdFxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVJbmNsdWRlQWxsID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5pbmNsdWRlQWxsKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5sb2FkU2NoZW1hKClcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuZ2V0T25lU2NoZW1hKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgY29uc3QgaW5jbHVkZUZpZWxkcyA9IFtdO1xuICAgICAgY29uc3Qga2V5RmllbGRzID0gW107XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHNjaGVtYS5maWVsZHMpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgJiZcbiAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcidcbiAgICAgICAgKSB7XG4gICAgICAgICAgaW5jbHVkZUZpZWxkcy5wdXNoKFtmaWVsZF0pO1xuICAgICAgICAgIGtleUZpZWxkcy5wdXNoKGZpZWxkKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gQWRkIGZpZWxkcyB0byBpbmNsdWRlLCBrZXlzLCByZW1vdmUgZHVwc1xuICAgICAgdGhpcy5pbmNsdWRlID0gWy4uLm5ldyBTZXQoWy4uLnRoaXMuaW5jbHVkZSwgLi4uaW5jbHVkZUZpZWxkc10pXTtcbiAgICAgIC8vIGlmIHRoaXMua2V5cyBub3Qgc2V0LCB0aGVuIGFsbCBrZXlzIGFyZSBhbHJlYWR5IGluY2x1ZGVkXG4gICAgICBpZiAodGhpcy5rZXlzKSB7XG4gICAgICAgIHRoaXMua2V5cyA9IFsuLi5uZXcgU2V0KFsuLi50aGlzLmtleXMsIC4uLmtleUZpZWxkc10pXTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cbi8vIFVwZGF0ZXMgcHJvcGVydHkgYHRoaXMua2V5c2AgdG8gY29udGFpbiBhbGwga2V5cyBidXQgdGhlIG9uZXMgdW5zZWxlY3RlZC5cblJlc3RRdWVyeS5wcm90b3R5cGUuaGFuZGxlRXhjbHVkZUtleXMgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLmV4Y2x1ZGVLZXlzKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aGlzLmtleXMpIHtcbiAgICB0aGlzLmtleXMgPSB0aGlzLmtleXMuZmlsdGVyKGsgPT4gIXRoaXMuZXhjbHVkZUtleXMuaW5jbHVkZXMoaykpO1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAubG9hZFNjaGVtYSgpXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYSh0aGlzLmNsYXNzTmFtZSkpXG4gICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpO1xuICAgICAgdGhpcy5rZXlzID0gZmllbGRzLmZpbHRlcihrID0+ICF0aGlzLmV4Y2x1ZGVLZXlzLmluY2x1ZGVzKGspKTtcbiAgICB9KTtcbn07XG5cbi8vIEF1Z21lbnRzIHRoaXMucmVzcG9uc2Ugd2l0aCBkYXRhIGF0IHRoZSBwYXRocyBwcm92aWRlZCBpbiB0aGlzLmluY2x1ZGUuXG5SZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUluY2x1ZGUgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuaW5jbHVkZS5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBwYXRoUmVzcG9uc2UgPSBpbmNsdWRlUGF0aChcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgdGhpcy5yZXNwb25zZSxcbiAgICB0aGlzLmluY2x1ZGVbMF0sXG4gICAgdGhpcy5yZXN0T3B0aW9uc1xuICApO1xuICBpZiAocGF0aFJlc3BvbnNlLnRoZW4pIHtcbiAgICByZXR1cm4gcGF0aFJlc3BvbnNlLnRoZW4obmV3UmVzcG9uc2UgPT4ge1xuICAgICAgdGhpcy5yZXNwb25zZSA9IG5ld1Jlc3BvbnNlO1xuICAgICAgdGhpcy5pbmNsdWRlID0gdGhpcy5pbmNsdWRlLnNsaWNlKDEpO1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlSW5jbHVkZSgpO1xuICAgIH0pO1xuICB9IGVsc2UgaWYgKHRoaXMuaW5jbHVkZS5sZW5ndGggPiAwKSB7XG4gICAgdGhpcy5pbmNsdWRlID0gdGhpcy5pbmNsdWRlLnNsaWNlKDEpO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGUoKTtcbiAgfVxuXG4gIHJldHVybiBwYXRoUmVzcG9uc2U7XG59O1xuXG4vL1JldHVybnMgYSBwcm9taXNlIG9mIGEgcHJvY2Vzc2VkIHNldCBvZiByZXN1bHRzXG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkFmdGVyRmluZFRyaWdnZXIgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyRmluZCcgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJGaW5kSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgaWYgKCFoYXNBZnRlckZpbmRIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFNraXAgQWdncmVnYXRlIGFuZCBEaXN0aW5jdCBRdWVyaWVzXG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLnBpcGVsaW5lIHx8IHRoaXMuZmluZE9wdGlvbnMuZGlzdGluY3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gUnVuIGFmdGVyRmluZCB0cmlnZ2VyIGFuZCBzZXQgdGhlIG5ldyByZXN1bHRzXG4gIHJldHVybiB0cmlnZ2Vyc1xuICAgIC5tYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlckZpbmQsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyxcbiAgICAgIHRoaXMuY29uZmlnXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgLy8gRW5zdXJlIHdlIHByb3Blcmx5IHNldCB0aGUgY2xhc3NOYW1lIGJhY2tcbiAgICAgIGlmICh0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lKSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkge1xuICAgICAgICAgICAgb2JqZWN0ID0gb2JqZWN0LnRvSlNPTigpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3QuY2xhc3NOYW1lID0gdGhpcy5yZWRpcmVjdENsYXNzTmFtZTtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0O1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHM7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG4vLyBBZGRzIGluY2x1ZGVkIHZhbHVlcyB0byB0aGUgcmVzcG9uc2UuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZCBuYW1lcy5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhbiBhdWdtZW50ZWQgcmVzcG9uc2UuXG5mdW5jdGlvbiBpbmNsdWRlUGF0aChjb25maWcsIGF1dGgsIHJlc3BvbnNlLCBwYXRoLCByZXN0T3B0aW9ucyA9IHt9KSB7XG4gIHZhciBwb2ludGVycyA9IGZpbmRQb2ludGVycyhyZXNwb25zZS5yZXN1bHRzLCBwYXRoKTtcbiAgaWYgKHBvaW50ZXJzLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG4gIGNvbnN0IHBvaW50ZXJzSGFzaCA9IHt9O1xuICBmb3IgKHZhciBwb2ludGVyIG9mIHBvaW50ZXJzKSB7XG4gICAgaWYgKCFwb2ludGVyKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NOYW1lID0gcG9pbnRlci5jbGFzc05hbWU7XG4gICAgLy8gb25seSBpbmNsdWRlIHRoZSBnb29kIHBvaW50ZXJzXG4gICAgaWYgKGNsYXNzTmFtZSkge1xuICAgICAgcG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0gPSBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSB8fCBuZXcgU2V0KCk7XG4gICAgICBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXS5hZGQocG9pbnRlci5vYmplY3RJZCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IGluY2x1ZGVSZXN0T3B0aW9ucyA9IHt9O1xuICBpZiAocmVzdE9wdGlvbnMua2V5cykge1xuICAgIGNvbnN0IGtleXMgPSBuZXcgU2V0KHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKSk7XG4gICAgY29uc3Qga2V5U2V0ID0gQXJyYXkuZnJvbShrZXlzKS5yZWR1Y2UoKHNldCwga2V5KSA9PiB7XG4gICAgICBjb25zdCBrZXlQYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgICBsZXQgaSA9IDA7XG4gICAgICBmb3IgKGk7IGkgPCBwYXRoLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChwYXRoW2ldICE9IGtleVBhdGhbaV0pIHtcbiAgICAgICAgICByZXR1cm4gc2V0O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoaSA8IGtleVBhdGgubGVuZ3RoKSB7XG4gICAgICAgIHNldC5hZGQoa2V5UGF0aFtpXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2V0O1xuICAgIH0sIG5ldyBTZXQoKSk7XG4gICAgaWYgKGtleVNldC5zaXplID4gMCkge1xuICAgICAgaW5jbHVkZVJlc3RPcHRpb25zLmtleXMgPSBBcnJheS5mcm9tKGtleVNldCkuam9pbignLCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgaW5jbHVkZVJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9XG4gICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAocmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXJ5UHJvbWlzZXMgPSBPYmplY3Qua2V5cyhwb2ludGVyc0hhc2gpLm1hcChjbGFzc05hbWUgPT4ge1xuICAgIGNvbnN0IG9iamVjdElkcyA9IEFycmF5LmZyb20ocG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0pO1xuICAgIGxldCB3aGVyZTtcbiAgICBpZiAob2JqZWN0SWRzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgd2hlcmUgPSB7IG9iamVjdElkOiBvYmplY3RJZHNbMF0gfTtcbiAgICB9IGVsc2Uge1xuICAgICAgd2hlcmUgPSB7IG9iamVjdElkOiB7ICRpbjogb2JqZWN0SWRzIH0gfTtcbiAgICB9XG4gICAgdmFyIHF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICAgIGNvbmZpZyxcbiAgICAgIGF1dGgsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICB3aGVyZSxcbiAgICAgIGluY2x1ZGVSZXN0T3B0aW9uc1xuICAgICk7XG4gICAgcmV0dXJuIHF1ZXJ5LmV4ZWN1dGUoeyBvcDogJ2dldCcgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXN1bHRzKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gR2V0IHRoZSBvYmplY3RzIGZvciBhbGwgdGhlc2Ugb2JqZWN0IGlkc1xuICByZXR1cm4gUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcykudGhlbihyZXNwb25zZXMgPT4ge1xuICAgIHZhciByZXBsYWNlID0gcmVzcG9uc2VzLnJlZHVjZSgocmVwbGFjZSwgaW5jbHVkZVJlc3BvbnNlKSA9PiB7XG4gICAgICBmb3IgKHZhciBvYmogb2YgaW5jbHVkZVJlc3BvbnNlLnJlc3VsdHMpIHtcbiAgICAgICAgb2JqLl9fdHlwZSA9ICdPYmplY3QnO1xuICAgICAgICBvYmouY2xhc3NOYW1lID0gaW5jbHVkZVJlc3BvbnNlLmNsYXNzTmFtZTtcblxuICAgICAgICBpZiAob2JqLmNsYXNzTmFtZSA9PSAnX1VzZXInICYmICFhdXRoLmlzTWFzdGVyKSB7XG4gICAgICAgICAgZGVsZXRlIG9iai5zZXNzaW9uVG9rZW47XG4gICAgICAgICAgZGVsZXRlIG9iai5hdXRoRGF0YTtcbiAgICAgICAgfVxuICAgICAgICByZXBsYWNlW29iai5vYmplY3RJZF0gPSBvYmo7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVwbGFjZTtcbiAgICB9LCB7fSk7XG5cbiAgICB2YXIgcmVzcCA9IHtcbiAgICAgIHJlc3VsdHM6IHJlcGxhY2VQb2ludGVycyhyZXNwb25zZS5yZXN1bHRzLCBwYXRoLCByZXBsYWNlKSxcbiAgICB9O1xuICAgIGlmIChyZXNwb25zZS5jb3VudCkge1xuICAgICAgcmVzcC5jb3VudCA9IHJlc3BvbnNlLmNvdW50O1xuICAgIH1cbiAgICByZXR1cm4gcmVzcDtcbiAgfSk7XG59XG5cbi8vIE9iamVjdCBtYXkgYmUgYSBsaXN0IG9mIFJFU1QtZm9ybWF0IG9iamVjdCB0byBmaW5kIHBvaW50ZXJzIGluLCBvclxuLy8gaXQgbWF5IGJlIGEgc2luZ2xlIG9iamVjdC5cbi8vIElmIHRoZSBwYXRoIHlpZWxkcyB0aGluZ3MgdGhhdCBhcmVuJ3QgcG9pbnRlcnMsIHRoaXMgdGhyb3dzIGFuIGVycm9yLlxuLy8gUGF0aCBpcyBhIGxpc3Qgb2YgZmllbGRzIHRvIHNlYXJjaCBpbnRvLlxuLy8gUmV0dXJucyBhIGxpc3Qgb2YgcG9pbnRlcnMgaW4gUkVTVCBmb3JtYXQuXG5mdW5jdGlvbiBmaW5kUG9pbnRlcnMob2JqZWN0LCBwYXRoKSB7XG4gIGlmIChvYmplY3QgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgIHZhciBhbnN3ZXIgPSBbXTtcbiAgICBmb3IgKHZhciB4IG9mIG9iamVjdCkge1xuICAgICAgYW5zd2VyID0gYW5zd2VyLmNvbmNhdChmaW5kUG9pbnRlcnMoeCwgcGF0aCkpO1xuICAgIH1cbiAgICByZXR1cm4gYW5zd2VyO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvYmplY3QgIT09ICdvYmplY3QnIHx8ICFvYmplY3QpIHtcbiAgICByZXR1cm4gW107XG4gIH1cblxuICBpZiAocGF0aC5sZW5ndGggPT0gMCkge1xuICAgIGlmIChvYmplY3QgPT09IG51bGwgfHwgb2JqZWN0Ll9fdHlwZSA9PSAnUG9pbnRlcicpIHtcbiAgICAgIHJldHVybiBbb2JqZWN0XTtcbiAgICB9XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgdmFyIHN1Ym9iamVjdCA9IG9iamVjdFtwYXRoWzBdXTtcbiAgaWYgKCFzdWJvYmplY3QpIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgcmV0dXJuIGZpbmRQb2ludGVycyhzdWJvYmplY3QsIHBhdGguc2xpY2UoMSkpO1xufVxuXG4vLyBPYmplY3QgbWF5IGJlIGEgbGlzdCBvZiBSRVNULWZvcm1hdCBvYmplY3RzIHRvIHJlcGxhY2UgcG9pbnRlcnNcbi8vIGluLCBvciBpdCBtYXkgYmUgYSBzaW5nbGUgb2JqZWN0LlxuLy8gUGF0aCBpcyBhIGxpc3Qgb2YgZmllbGRzIHRvIHNlYXJjaCBpbnRvLlxuLy8gcmVwbGFjZSBpcyBhIG1hcCBmcm9tIG9iamVjdCBpZCAtPiBvYmplY3QuXG4vLyBSZXR1cm5zIHNvbWV0aGluZyBhbmFsb2dvdXMgdG8gb2JqZWN0LCBidXQgd2l0aCB0aGUgYXBwcm9wcmlhdGVcbi8vIHBvaW50ZXJzIGluZmxhdGVkLlxuZnVuY3Rpb24gcmVwbGFjZVBvaW50ZXJzKG9iamVjdCwgcGF0aCwgcmVwbGFjZSkge1xuICBpZiAob2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICByZXR1cm4gb2JqZWN0XG4gICAgICAubWFwKG9iaiA9PiByZXBsYWNlUG9pbnRlcnMob2JqLCBwYXRoLCByZXBsYWNlKSlcbiAgICAgIC5maWx0ZXIob2JqID0+IHR5cGVvZiBvYmogIT09ICd1bmRlZmluZWQnKTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIGlmIChwYXRoLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChvYmplY3QgJiYgb2JqZWN0Ll9fdHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gcmVwbGFjZVtvYmplY3Qub2JqZWN0SWRdO1xuICAgIH1cbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgdmFyIHN1Ym9iamVjdCA9IG9iamVjdFtwYXRoWzBdXTtcbiAgaWYgKCFzdWJvYmplY3QpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIHZhciBuZXdzdWIgPSByZXBsYWNlUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpLCByZXBsYWNlKTtcbiAgdmFyIGFuc3dlciA9IHt9O1xuICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgaWYgKGtleSA9PSBwYXRoWzBdKSB7XG4gICAgICBhbnN3ZXJba2V5XSA9IG5ld3N1YjtcbiAgICB9IGVsc2Uge1xuICAgICAgYW5zd2VyW2tleV0gPSBvYmplY3Rba2V5XTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGFuc3dlcjtcbn1cblxuLy8gRmluZHMgYSBzdWJvYmplY3QgdGhhdCBoYXMgdGhlIGdpdmVuIGtleSwgaWYgdGhlcmUgaXMgb25lLlxuLy8gUmV0dXJucyB1bmRlZmluZWQgb3RoZXJ3aXNlLlxuZnVuY3Rpb24gZmluZE9iamVjdFdpdGhLZXkocm9vdCwga2V5KSB7XG4gIGlmICh0eXBlb2Ygcm9vdCAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHJvb3QgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgIGZvciAodmFyIGl0ZW0gb2Ygcm9vdCkge1xuICAgICAgY29uc3QgYW5zd2VyID0gZmluZE9iamVjdFdpdGhLZXkoaXRlbSwga2V5KTtcbiAgICAgIGlmIChhbnN3ZXIpIHtcbiAgICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKHJvb3QgJiYgcm9vdFtrZXldKSB7XG4gICAgcmV0dXJuIHJvb3Q7XG4gIH1cbiAgZm9yICh2YXIgc3Via2V5IGluIHJvb3QpIHtcbiAgICBjb25zdCBhbnN3ZXIgPSBmaW5kT2JqZWN0V2l0aEtleShyb290W3N1YmtleV0sIGtleSk7XG4gICAgaWYgKGFuc3dlcikge1xuICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdHJhY2VQcm9taXNlKG9wZXJhdGlvbiwgY2xhc3NOYW1lLCBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCkpIHtcbiAgY29uc3QgcGFyZW50ID0gQVdTWFJheS5nZXRTZWdtZW50KCk7XG4gIGlmICghcGFyZW50KSB7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBBV1NYUmF5LmNhcHR1cmVBc3luY0Z1bmMoJ1BhcnNlLVNlcnZlcicsIHN1YnNlZ21lbnQgPT4ge1xuICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ0NvbnRyb2xsZXInLCAnUmVzdFF1ZXJ5Jyk7XG4gICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignT3BlcmF0aW9uJywgb3BlcmF0aW9uKTtcbiAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDbGFzc05hbWUnLCBjbGFzc05hbWUpO1xuICAgICAgcHJvbWlzZS50aGVuKFxuICAgICAgICBmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgIH0sXG4gICAgICAgIGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuY2xvc2UoZXJyb3IpO1xuICAgICAgICB9XG4gICAgICApO1xuICAgIH0pO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBSZXN0UXVlcnk7XG4iXX0=