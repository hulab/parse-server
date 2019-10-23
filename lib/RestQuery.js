"use strict";

// An object that encapsulates everything we need to run a 'find'
// operation, encoded in the REST API format.
const AWSXRay = require('hulab-xray-sdk');

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

function RestQuery(config, auth, className, restWhere = {}, restOptions = {}, clientSDK, runAfterFind = true) {
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.restWhere = restWhere;
  this.restOptions = restOptions;
  this.clientSDK = clientSDK;
  this.runAfterFind = runAfterFind;
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

      case 'explain':
      case 'hint':
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
  }

  if (!this.runAfterFind) {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0UXVlcnkuanMiXSwibmFtZXMiOlsiQVdTWFJheSIsInJlcXVpcmUiLCJTY2hlbWFDb250cm9sbGVyIiwiUGFyc2UiLCJ0cmlnZ2VycyIsImNvbnRpbnVlV2hpbGUiLCJBbHdheXNTZWxlY3RlZEtleXMiLCJSZXN0UXVlcnkiLCJjb25maWciLCJhdXRoIiwiY2xhc3NOYW1lIiwicmVzdFdoZXJlIiwicmVzdE9wdGlvbnMiLCJjbGllbnRTREsiLCJydW5BZnRlckZpbmQiLCJyZXNwb25zZSIsImZpbmRPcHRpb25zIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiRXJyb3IiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCIkYW5kIiwiX190eXBlIiwib2JqZWN0SWQiLCJpZCIsImRvQ291bnQiLCJpbmNsdWRlQWxsIiwiaW5jbHVkZSIsIk9iamVjdCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImtleXNGb3JJbmNsdWRlIiwia2V5cyIsInNwbGl0IiwiZmlsdGVyIiwia2V5IiwibGVuZ3RoIiwibWFwIiwic2xpY2UiLCJsYXN0SW5kZXhPZiIsImpvaW4iLCJvcHRpb24iLCJjb25jYXQiLCJBcnJheSIsImZyb20iLCJTZXQiLCJleGNsdWRlIiwiZXhjbHVkZUtleXMiLCJrIiwiaW5kZXhPZiIsImZpZWxkcyIsIm9yZGVyIiwic29ydCIsInJlZHVjZSIsInNvcnRNYXAiLCJmaWVsZCIsInRyaW0iLCJzY29yZSIsIiRtZXRhIiwicGF0aHMiLCJpbmNsdWRlcyIsInBhdGhTZXQiLCJtZW1vIiwicGF0aCIsImluZGV4IiwicGFydHMiLCJzIiwiYSIsImIiLCJyZWRpcmVjdEtleSIsInJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IiwicmVkaXJlY3RDbGFzc05hbWUiLCJJTlZBTElEX0pTT04iLCJleGVjdXRlIiwiZXhlY3V0ZU9wdGlvbnMiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJ0cmFjZVByb21pc2UiLCJidWlsZFJlc3RXaGVyZSIsImhhbmRsZUluY2x1ZGVBbGwiLCJoYW5kbGVFeGNsdWRlS2V5cyIsInJ1bkZpbmQiLCJydW5Db3VudCIsImhhbmRsZUluY2x1ZGUiLCJydW5BZnRlckZpbmRUcmlnZ2VyIiwiZWFjaCIsImNhbGxiYWNrIiwibGltaXQiLCJmaW5pc2hlZCIsInF1ZXJ5IiwicmVzdWx0cyIsImZvckVhY2giLCJhc3NpZ24iLCIkZ3QiLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsInJlcGxhY2VTZWxlY3QiLCJyZXBsYWNlRG9udFNlbGVjdCIsInJlcGxhY2VJblF1ZXJ5IiwicmVwbGFjZU5vdEluUXVlcnkiLCJyZXBsYWNlRXF1YWxpdHkiLCJhY2wiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImRhdGFiYXNlIiwibmV3Q2xhc3NOYW1lIiwiYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwic3lzdGVtQ2xhc3NlcyIsImxvYWRTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwiaGFzQ2xhc3MiLCJPUEVSQVRJT05fRk9SQklEREVOIiwidHJhbnNmb3JtSW5RdWVyeSIsImluUXVlcnlPYmplY3QiLCJ2YWx1ZXMiLCJyZXN1bHQiLCJwdXNoIiwiaXNBcnJheSIsImZpbmRPYmplY3RXaXRoS2V5IiwiaW5RdWVyeVZhbHVlIiwid2hlcmUiLCJJTlZBTElEX1FVRVJZIiwiYWRkaXRpb25hbE9wdGlvbnMiLCJzdWJxdWVyeVJlYWRQcmVmZXJlbmNlIiwicmVhZFByZWZlcmVuY2UiLCJzdWJxdWVyeSIsInRyYW5zZm9ybU5vdEluUXVlcnkiLCJub3RJblF1ZXJ5T2JqZWN0Iiwibm90SW5RdWVyeVZhbHVlIiwiZ2V0RGVlcGVzdE9iamVjdEZyb21LZXkiLCJqc29uIiwiaWR4Iiwic3JjIiwic3BsaWNlIiwidHJhbnNmb3JtU2VsZWN0Iiwic2VsZWN0T2JqZWN0Iiwib2JqZWN0cyIsInNlbGVjdFZhbHVlIiwidHJhbnNmb3JtRG9udFNlbGVjdCIsImRvbnRTZWxlY3RPYmplY3QiLCJkb250U2VsZWN0VmFsdWUiLCJjbGVhblJlc3VsdEF1dGhEYXRhIiwicGFzc3dvcmQiLCJhdXRoRGF0YSIsInByb3ZpZGVyIiwicmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCIsImNvbnN0cmFpbnQiLCJlcXVhbFRvT2JqZWN0IiwiaGFzRGlyZWN0Q29uc3RyYWludCIsImhhc09wZXJhdG9yQ29uc3RyYWludCIsIm9wdGlvbnMiLCJvcCIsImZpbmQiLCJmaWxlc0NvbnRyb2xsZXIiLCJleHBhbmRGaWxlc0luT2JqZWN0IiwiciIsImNvdW50Iiwic2tpcCIsImMiLCJnZXRPbmVTY2hlbWEiLCJzY2hlbWEiLCJpbmNsdWRlRmllbGRzIiwia2V5RmllbGRzIiwidHlwZSIsInBhdGhSZXNwb25zZSIsImluY2x1ZGVQYXRoIiwibmV3UmVzcG9uc2UiLCJoYXNBZnRlckZpbmRIb29rIiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYWZ0ZXJGaW5kIiwiYXBwbGljYXRpb25JZCIsInBpcGVsaW5lIiwiZGlzdGluY3QiLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJvYmplY3QiLCJ0b0pTT04iLCJwb2ludGVycyIsImZpbmRQb2ludGVycyIsInBvaW50ZXJzSGFzaCIsInBvaW50ZXIiLCJhZGQiLCJpbmNsdWRlUmVzdE9wdGlvbnMiLCJrZXlTZXQiLCJzZXQiLCJrZXlQYXRoIiwiaSIsInNpemUiLCJpbmNsdWRlUmVhZFByZWZlcmVuY2UiLCJxdWVyeVByb21pc2VzIiwib2JqZWN0SWRzIiwiJGluIiwiYWxsIiwicmVzcG9uc2VzIiwicmVwbGFjZSIsImluY2x1ZGVSZXNwb25zZSIsIm9iaiIsInNlc3Npb25Ub2tlbiIsInJlc3AiLCJyZXBsYWNlUG9pbnRlcnMiLCJhbnN3ZXIiLCJ4Iiwic3Vib2JqZWN0IiwibmV3c3ViIiwicm9vdCIsIml0ZW0iLCJzdWJrZXkiLCJvcGVyYXRpb24iLCJwcm9taXNlIiwicGFyZW50IiwiZ2V0U2VnbWVudCIsInJlamVjdCIsImNhcHR1cmVBc3luY0Z1bmMiLCJzdWJzZWdt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TSxDQUFDSyxLQUFELENBQU47QUFDQUgsUUFBQUEsVUFBVSxJQUFJQSxVQUFVLENBQUNFLEtBQVgsQ0FBaUJDLEtBQWpCLENBQWQ7QUFDRCxPQVJIO0FBVUQsS0FoQkg7QUFrQkQsR0FuQk0sQ0FBUDtBQW9CRDs7QUFFREMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCck4sU0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBBbiBvYmplY3QgdGhhdCBlbmNhcHN1bGF0ZXMgZXZlcnl0aGluZyB3ZSBuZWVkIHRvIHJ1biBhICdmaW5kJ1xuLy8gb3BlcmF0aW9uLCBlbmNvZGVkIGluIHRoZSBSRVNUIEFQSSBmb3JtYXQuXG5jb25zdCBBV1NYUmF5ID0gcmVxdWlyZSgnaHVsYWIteHJheS1zZGsnKTtcblxudmFyIFNjaGVtYUNvbnRyb2xsZXIgPSByZXF1aXJlKCcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZTtcbmNvbnN0IHRyaWdnZXJzID0gcmVxdWlyZSgnLi90cmlnZ2VycycpO1xuY29uc3QgeyBjb250aW51ZVdoaWxlIH0gPSByZXF1aXJlKCdwYXJzZS9saWIvbm9kZS9wcm9taXNlVXRpbHMnKTtcbmNvbnN0IEFsd2F5c1NlbGVjdGVkS2V5cyA9IFsnb2JqZWN0SWQnLCAnY3JlYXRlZEF0JywgJ3VwZGF0ZWRBdCcsICdBQ0wnXTtcbi8vIHJlc3RPcHRpb25zIGNhbiBpbmNsdWRlOlxuLy8gICBza2lwXG4vLyAgIGxpbWl0XG4vLyAgIG9yZGVyXG4vLyAgIGNvdW50XG4vLyAgIGluY2x1ZGVcbi8vICAga2V5c1xuLy8gICBleGNsdWRlS2V5c1xuLy8gICByZWRpcmVjdENsYXNzTmFtZUZvcktleVxuLy8gICByZWFkUHJlZmVyZW5jZVxuLy8gICBpbmNsdWRlUmVhZFByZWZlcmVuY2Vcbi8vICAgc3VicXVlcnlSZWFkUHJlZmVyZW5jZVxuZnVuY3Rpb24gUmVzdFF1ZXJ5KFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlID0ge30sXG4gIHJlc3RPcHRpb25zID0ge30sXG4gIGNsaWVudFNESyxcbiAgcnVuQWZ0ZXJGaW5kID0gdHJ1ZVxuKSB7XG4gIHRoaXMuY29uZmlnID0gY29uZmlnO1xuICB0aGlzLmF1dGggPSBhdXRoO1xuICB0aGlzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgdGhpcy5yZXN0V2hlcmUgPSByZXN0V2hlcmU7XG4gIHRoaXMucmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucztcbiAgdGhpcy5jbGllbnRTREsgPSBjbGllbnRTREs7XG4gIHRoaXMucnVuQWZ0ZXJGaW5kID0gcnVuQWZ0ZXJGaW5kO1xuICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcbiAgdGhpcy5maW5kT3B0aW9ucyA9IHt9O1xuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09ICdfU2Vzc2lvbicpIHtcbiAgICAgIGlmICghdGhpcy5hdXRoLnVzZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTixcbiAgICAgICAgICAnSW52YWxpZCBzZXNzaW9uIHRva2VuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdGhpcy5yZXN0V2hlcmUgPSB7XG4gICAgICAgICRhbmQ6IFtcbiAgICAgICAgICB0aGlzLnJlc3RXaGVyZSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgdGhpcy5kb0NvdW50ID0gZmFsc2U7XG4gIHRoaXMuaW5jbHVkZUFsbCA9IGZhbHNlO1xuXG4gIC8vIFRoZSBmb3JtYXQgZm9yIHRoaXMuaW5jbHVkZSBpcyBub3QgdGhlIHNhbWUgYXMgdGhlIGZvcm1hdCBmb3IgdGhlXG4gIC8vIGluY2x1ZGUgb3B0aW9uIC0gaXQncyB0aGUgcGF0aHMgd2Ugc2hvdWxkIGluY2x1ZGUsIGluIG9yZGVyLFxuICAvLyBzdG9yZWQgYXMgYXJyYXlzLCB0YWtpbmcgaW50byBhY2NvdW50IHRoYXQgd2UgbmVlZCB0byBpbmNsdWRlIGZvb1xuICAvLyBiZWZvcmUgaW5jbHVkaW5nIGZvby5iYXIuIEFsc28gaXQgc2hvdWxkIGRlZHVwZS5cbiAgLy8gRm9yIGV4YW1wbGUsIHBhc3NpbmcgYW4gYXJnIG9mIGluY2x1ZGU9Zm9vLmJhcixmb28uYmF6IGNvdWxkIGxlYWQgdG9cbiAgLy8gdGhpcy5pbmNsdWRlID0gW1snZm9vJ10sIFsnZm9vJywgJ2JheiddLCBbJ2ZvbycsICdiYXInXV1cbiAgdGhpcy5pbmNsdWRlID0gW107XG5cbiAgLy8gSWYgd2UgaGF2ZSBrZXlzLCB3ZSBwcm9iYWJseSB3YW50IHRvIGZvcmNlIHNvbWUgaW5jbHVkZXMgKG4tMSBsZXZlbClcbiAgLy8gU2VlIGlzc3VlOiBodHRwczovL2dpdGh1Yi5jb20vcGFyc2UtY29tbXVuaXR5L3BhcnNlLXNlcnZlci9pc3N1ZXMvMzE4NVxuICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3RPcHRpb25zLCAna2V5cycpKSB7XG4gICAgY29uc3Qga2V5c0ZvckluY2x1ZGUgPSByZXN0T3B0aW9ucy5rZXlzXG4gICAgICAuc3BsaXQoJywnKVxuICAgICAgLmZpbHRlcihrZXkgPT4ge1xuICAgICAgICAvLyBBdCBsZWFzdCAyIGNvbXBvbmVudHNcbiAgICAgICAgcmV0dXJuIGtleS5zcGxpdCgnLicpLmxlbmd0aCA+IDE7XG4gICAgICB9KVxuICAgICAgLm1hcChrZXkgPT4ge1xuICAgICAgICAvLyBTbGljZSB0aGUgbGFzdCBjb21wb25lbnQgKGEuYi5jIC0+IGEuYilcbiAgICAgICAgLy8gT3RoZXJ3aXNlIHdlJ2xsIGluY2x1ZGUgb25lIGxldmVsIHRvbyBtdWNoLlxuICAgICAgICByZXR1cm4ga2V5LnNsaWNlKDAsIGtleS5sYXN0SW5kZXhPZignLicpKTtcbiAgICAgIH0pXG4gICAgICAuam9pbignLCcpO1xuXG4gICAgLy8gQ29uY2F0IHRoZSBwb3NzaWJseSBwcmVzZW50IGluY2x1ZGUgc3RyaW5nIHdpdGggdGhlIG9uZSBmcm9tIHRoZSBrZXlzXG4gICAgLy8gRGVkdXAgLyBzb3J0aW5nIGlzIGhhbmRsZSBpbiAnaW5jbHVkZScgY2FzZS5cbiAgICBpZiAoa2V5c0ZvckluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgICAgaWYgKCFyZXN0T3B0aW9ucy5pbmNsdWRlIHx8IHJlc3RPcHRpb25zLmluY2x1ZGUubGVuZ3RoID09IDApIHtcbiAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSA9IGtleXNGb3JJbmNsdWRlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSArPSAnLCcgKyBrZXlzRm9ySW5jbHVkZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmb3IgKHZhciBvcHRpb24gaW4gcmVzdE9wdGlvbnMpIHtcbiAgICBzd2l0Y2ggKG9wdGlvbikge1xuICAgICAgY2FzZSAna2V5cyc6IHtcbiAgICAgICAgY29uc3Qga2V5cyA9IHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKS5jb25jYXQoQWx3YXlzU2VsZWN0ZWRLZXlzKTtcbiAgICAgICAgdGhpcy5rZXlzID0gQXJyYXkuZnJvbShuZXcgU2V0KGtleXMpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdleGNsdWRlS2V5cyc6IHtcbiAgICAgICAgY29uc3QgZXhjbHVkZSA9IHJlc3RPcHRpb25zLmV4Y2x1ZGVLZXlzXG4gICAgICAgICAgLnNwbGl0KCcsJylcbiAgICAgICAgICAuZmlsdGVyKGsgPT4gQWx3YXlzU2VsZWN0ZWRLZXlzLmluZGV4T2YoaykgPCAwKTtcbiAgICAgICAgdGhpcy5leGNsdWRlS2V5cyA9IEFycmF5LmZyb20obmV3IFNldChleGNsdWRlKSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAnY291bnQnOlxuICAgICAgICB0aGlzLmRvQ291bnQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2luY2x1ZGVBbGwnOlxuICAgICAgICB0aGlzLmluY2x1ZGVBbGwgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2V4cGxhaW4nOlxuICAgICAgY2FzZSAnaGludCc6XG4gICAgICBjYXNlICdkaXN0aW5jdCc6XG4gICAgICBjYXNlICdwaXBlbGluZSc6XG4gICAgICBjYXNlICdza2lwJzpcbiAgICAgIGNhc2UgJ2xpbWl0JzpcbiAgICAgIGNhc2UgJ3JlYWRQcmVmZXJlbmNlJzpcbiAgICAgICAgdGhpcy5maW5kT3B0aW9uc1tvcHRpb25dID0gcmVzdE9wdGlvbnNbb3B0aW9uXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdvcmRlcic6XG4gICAgICAgIHZhciBmaWVsZHMgPSByZXN0T3B0aW9ucy5vcmRlci5zcGxpdCgnLCcpO1xuICAgICAgICB0aGlzLmZpbmRPcHRpb25zLnNvcnQgPSBmaWVsZHMucmVkdWNlKChzb3J0TWFwLCBmaWVsZCkgPT4ge1xuICAgICAgICAgIGZpZWxkID0gZmllbGQudHJpbSgpO1xuICAgICAgICAgIGlmIChmaWVsZCA9PT0gJyRzY29yZScpIHtcbiAgICAgICAgICAgIHNvcnRNYXAuc2NvcmUgPSB7ICRtZXRhOiAndGV4dFNjb3JlJyB9O1xuICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRbMF0gPT0gJy0nKSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkLnNsaWNlKDEpXSA9IC0xO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkXSA9IDE7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBzb3J0TWFwO1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZSc6IHtcbiAgICAgICAgY29uc3QgcGF0aHMgPSByZXN0T3B0aW9ucy5pbmNsdWRlLnNwbGl0KCcsJyk7XG4gICAgICAgIGlmIChwYXRocy5pbmNsdWRlcygnKicpKSB7XG4gICAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICAvLyBMb2FkIHRoZSBleGlzdGluZyBpbmNsdWRlcyAoZnJvbSBrZXlzKVxuICAgICAgICBjb25zdCBwYXRoU2V0ID0gcGF0aHMucmVkdWNlKChtZW1vLCBwYXRoKSA9PiB7XG4gICAgICAgICAgLy8gU3BsaXQgZWFjaCBwYXRocyBvbiAuIChhLmIuYyAtPiBbYSxiLGNdKVxuICAgICAgICAgIC8vIHJlZHVjZSB0byBjcmVhdGUgYWxsIHBhdGhzXG4gICAgICAgICAgLy8gKFthLGIsY10gLT4ge2E6IHRydWUsICdhLmInOiB0cnVlLCAnYS5iLmMnOiB0cnVlfSlcbiAgICAgICAgICByZXR1cm4gcGF0aC5zcGxpdCgnLicpLnJlZHVjZSgobWVtbywgcGF0aCwgaW5kZXgsIHBhcnRzKSA9PiB7XG4gICAgICAgICAgICBtZW1vW3BhcnRzLnNsaWNlKDAsIGluZGV4ICsgMSkuam9pbignLicpXSA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgICAgICB9LCBtZW1vKTtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIHRoaXMuaW5jbHVkZSA9IE9iamVjdC5rZXlzKHBhdGhTZXQpXG4gICAgICAgICAgLm1hcChzID0+IHtcbiAgICAgICAgICAgIHJldHVybiBzLnNwbGl0KCcuJyk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7IC8vIFNvcnQgYnkgbnVtYmVyIG9mIGNvbXBvbmVudHNcbiAgICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdyZWRpcmVjdENsYXNzTmFtZUZvcktleSc6XG4gICAgICAgIHRoaXMucmVkaXJlY3RLZXkgPSByZXN0T3B0aW9ucy5yZWRpcmVjdENsYXNzTmFtZUZvcktleTtcbiAgICAgICAgdGhpcy5yZWRpcmVjdENsYXNzTmFtZSA9IG51bGw7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgIGNhc2UgJ3N1YnF1ZXJ5UmVhZFByZWZlcmVuY2UnOlxuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCBvcHRpb246ICcgKyBvcHRpb25cbiAgICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyBhIHF1ZXJ5XG4vLyBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB0aGUgcmVzcG9uc2UgLSBhbiBvYmplY3Qgd2l0aCBvcHRpb25hbCBrZXlzXG4vLyAncmVzdWx0cycgYW5kICdjb3VudCcuXG4vLyBUT0RPOiBjb25zb2xpZGF0ZSB0aGUgcmVwbGFjZVggZnVuY3Rpb25zXG5SZXN0UXVlcnkucHJvdG90eXBlLmV4ZWN1dGUgPSBmdW5jdGlvbihleGVjdXRlT3B0aW9ucykge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnYnVpbGRSZXN0V2hlcmUnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5idWlsZFJlc3RXaGVyZSgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ2hhbmRsZUluY2x1ZGVBbGwnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5oYW5kbGVJbmNsdWRlQWxsKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnaGFuZGxlRXhjbHVkZUtleXMnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5oYW5kbGVFeGNsdWRlS2V5cygpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3J1bkZpbmQnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5ydW5GaW5kKGV4ZWN1dGVPcHRpb25zKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoJ3J1bkNvdW50JywgdGhpcy5jbGFzc05hbWUsIHRoaXMucnVuQ291bnQoKSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnaGFuZGxlSW5jbHVkZScsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmhhbmRsZUluY2x1ZGUoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdydW5BZnRlckZpbmRUcmlnZ2VyJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucnVuQWZ0ZXJGaW5kVHJpZ2dlcigpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVzcG9uc2U7XG4gICAgfSk7XG59O1xuXG5SZXN0UXVlcnkucHJvdG90eXBlLmVhY2ggPSBmdW5jdGlvbihjYWxsYmFjaykge1xuICBjb25zdCB7IGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCByZXN0V2hlcmUsIHJlc3RPcHRpb25zLCBjbGllbnRTREsgfSA9IHRoaXM7XG4gIC8vIGlmIHRoZSBsaW1pdCBpcyBzZXQsIHVzZSBpdFxuICByZXN0T3B0aW9ucy5saW1pdCA9IHJlc3RPcHRpb25zLmxpbWl0IHx8IDEwMDtcbiAgcmVzdE9wdGlvbnMub3JkZXIgPSAnb2JqZWN0SWQnO1xuICBsZXQgZmluaXNoZWQgPSBmYWxzZTtcblxuICByZXR1cm4gY29udGludWVXaGlsZShcbiAgICAoKSA9PiB7XG4gICAgICByZXR1cm4gIWZpbmlzaGVkO1xuICAgIH0sXG4gICAgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgY2xpZW50U0RLXG4gICAgICApO1xuICAgICAgY29uc3QgeyByZXN1bHRzIH0gPSBhd2FpdCBxdWVyeS5leGVjdXRlKCk7XG4gICAgICByZXN1bHRzLmZvckVhY2goY2FsbGJhY2spO1xuICAgICAgZmluaXNoZWQgPSByZXN1bHRzLmxlbmd0aCA8IHJlc3RPcHRpb25zLmxpbWl0O1xuICAgICAgaWYgKCFmaW5pc2hlZCkge1xuICAgICAgICByZXN0V2hlcmUub2JqZWN0SWQgPSBPYmplY3QuYXNzaWduKHt9LCByZXN0V2hlcmUub2JqZWN0SWQsIHtcbiAgICAgICAgICAkZ3Q6IHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXS5vYmplY3RJZCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICApO1xufTtcblxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5idWlsZFJlc3RXaGVyZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnZ2V0VXNlckFuZFJvbGVBQ0wnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3JlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5JyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWVGb3JLZXkoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICd2YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24nLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdyZXBsYWNlU2VsZWN0JyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucmVwbGFjZVNlbGVjdCgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3JlcGxhY2VEb250U2VsZWN0JyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdyZXBsYWNlSW5RdWVyeScsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLnJlcGxhY2VJblF1ZXJ5KClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAncmVwbGFjZU5vdEluUXVlcnknLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3JlcGxhY2VFcXVhbGl0eScsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLnJlcGxhY2VFcXVhbGl0eSgpXG4gICAgICApO1xuICAgIH0pO1xufTtcblxuLy8gVXNlcyB0aGUgQXV0aCBvYmplY3QgdG8gZ2V0IHRoZSBsaXN0IG9mIHJvbGVzLCBhZGRzIHRoZSB1c2VyIGlkXG5SZXN0UXVlcnkucHJvdG90eXBlLmdldFVzZXJBbmRSb2xlQUNMID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB0aGlzLmZpbmRPcHRpb25zLmFjbCA9IFsnKiddO1xuXG4gIGlmICh0aGlzLmF1dGgudXNlcikge1xuICAgIHJldHVybiB0aGlzLmF1dGguZ2V0VXNlclJvbGVzKCkudGhlbihyb2xlcyA9PiB7XG4gICAgICB0aGlzLmZpbmRPcHRpb25zLmFjbCA9IHRoaXMuZmluZE9wdGlvbnMuYWNsLmNvbmNhdChyb2xlcywgW1xuICAgICAgICB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgIF0pO1xuICAgICAgcmV0dXJuO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gQ2hhbmdlcyB0aGUgY2xhc3NOYW1lIGlmIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IGlzIHNldC5cbi8vIFJldHVybnMgYSBwcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMucmVkaXJlY3RLZXkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBXZSBuZWVkIHRvIGNoYW5nZSB0aGUgY2xhc3MgbmFtZSBiYXNlZCBvbiB0aGUgc2NoZW1hXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5yZWRpcmVjdENsYXNzTmFtZUZvcktleSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZWRpcmVjdEtleSlcbiAgICAudGhlbihuZXdDbGFzc05hbWUgPT4ge1xuICAgICAgdGhpcy5jbGFzc05hbWUgPSBuZXdDbGFzc05hbWU7XG4gICAgICB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lID0gbmV3Q2xhc3NOYW1lO1xuICAgIH0pO1xufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIGFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiBjb25maWcuXG5SZXN0UXVlcnkucHJvdG90eXBlLnZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAoXG4gICAgdGhpcy5jb25maWcuYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uID09PSBmYWxzZSAmJlxuICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICBTY2hlbWFDb250cm9sbGVyLnN5c3RlbUNsYXNzZXMuaW5kZXhPZih0aGlzLmNsYXNzTmFtZSkgPT09IC0xXG4gICkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmhhc0NsYXNzKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGhhc0NsYXNzID0+IHtcbiAgICAgICAgaWYgKGhhc0NsYXNzICE9PSB0cnVlKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgICdUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gYWNjZXNzICcgK1xuICAgICAgICAgICAgICAnbm9uLWV4aXN0ZW50IGNsYXNzOiAnICtcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWVcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybUluUXVlcnkoaW5RdWVyeU9iamVjdCwgY2xhc3NOYW1lLCByZXN1bHRzKSB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICB2YWx1ZXMucHVzaCh7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IHJlc3VsdC5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBkZWxldGUgaW5RdWVyeU9iamVjdFsnJGluUXVlcnknXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoaW5RdWVyeU9iamVjdFsnJGluJ10pKSB7XG4gICAgaW5RdWVyeU9iamVjdFsnJGluJ10gPSBpblF1ZXJ5T2JqZWN0WyckaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBpblF1ZXJ5T2JqZWN0WyckaW4nXSA9IHZhbHVlcztcbiAgfVxufVxuXG4vLyBSZXBsYWNlcyBhICRpblF1ZXJ5IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYW5cbi8vICRpblF1ZXJ5IGNsYXVzZS5cbi8vIFRoZSAkaW5RdWVyeSBjbGF1c2UgdHVybnMgaW50byBhbiAkaW4gd2l0aCB2YWx1ZXMgdGhhdCBhcmUganVzdFxuLy8gcG9pbnRlcnMgdG8gdGhlIG9iamVjdHMgcmV0dXJuZWQgaW4gdGhlIHN1YnF1ZXJ5LlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlSW5RdWVyeSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgaW5RdWVyeU9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJGluUXVlcnknKTtcbiAgaWYgKCFpblF1ZXJ5T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIGluUXVlcnkgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHdoZXJlIGFuZCBjbGFzc05hbWVcbiAgdmFyIGluUXVlcnlWYWx1ZSA9IGluUXVlcnlPYmplY3RbJyRpblF1ZXJ5J107XG4gIGlmICghaW5RdWVyeVZhbHVlLndoZXJlIHx8ICFpblF1ZXJ5VmFsdWUuY2xhc3NOYW1lKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICdpbXByb3BlciB1c2FnZSBvZiAkaW5RdWVyeSdcbiAgICApO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGluUXVlcnlWYWx1ZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgaW5RdWVyeVZhbHVlLmNsYXNzTmFtZSxcbiAgICBpblF1ZXJ5VmFsdWUud2hlcmUsXG4gICAgYWRkaXRpb25hbE9wdGlvbnNcbiAgKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1JblF1ZXJ5KGluUXVlcnlPYmplY3QsIHN1YnF1ZXJ5LmNsYXNzTmFtZSwgcmVzcG9uc2UucmVzdWx0cyk7XG4gICAgLy8gUmVjdXJzZSB0byByZXBlYXRcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlSW5RdWVyeSgpO1xuICB9KTtcbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybU5vdEluUXVlcnkobm90SW5RdWVyeU9iamVjdCwgY2xhc3NOYW1lLCByZXN1bHRzKSB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICB2YWx1ZXMucHVzaCh7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IHJlc3VsdC5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBkZWxldGUgbm90SW5RdWVyeU9iamVjdFsnJG5vdEluUXVlcnknXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkobm90SW5RdWVyeU9iamVjdFsnJG5pbiddKSkge1xuICAgIG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSA9IG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10gPSB2YWx1ZXM7XG4gIH1cbn1cblxuLy8gUmVwbGFjZXMgYSAkbm90SW5RdWVyeSBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFuXG4vLyAkbm90SW5RdWVyeSBjbGF1c2UuXG4vLyBUaGUgJG5vdEluUXVlcnkgY2xhdXNlIHR1cm5zIGludG8gYSAkbmluIHdpdGggdmFsdWVzIHRoYXQgYXJlIGp1c3Rcbi8vIHBvaW50ZXJzIHRvIHRoZSBvYmplY3RzIHJldHVybmVkIGluIHRoZSBzdWJxdWVyeS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZU5vdEluUXVlcnkgPSBmdW5jdGlvbigpIHtcbiAgdmFyIG5vdEluUXVlcnlPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRub3RJblF1ZXJ5Jyk7XG4gIGlmICghbm90SW5RdWVyeU9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBub3RJblF1ZXJ5IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSB3aGVyZSBhbmQgY2xhc3NOYW1lXG4gIHZhciBub3RJblF1ZXJ5VmFsdWUgPSBub3RJblF1ZXJ5T2JqZWN0Wyckbm90SW5RdWVyeSddO1xuICBpZiAoIW5vdEluUXVlcnlWYWx1ZS53aGVyZSB8fCAhbm90SW5RdWVyeVZhbHVlLmNsYXNzTmFtZSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJG5vdEluUXVlcnknXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBub3RJblF1ZXJ5VmFsdWUucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIHZhciBzdWJxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIG5vdEluUXVlcnlWYWx1ZS5jbGFzc05hbWUsXG4gICAgbm90SW5RdWVyeVZhbHVlLndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtTm90SW5RdWVyeShub3RJblF1ZXJ5T2JqZWN0LCBzdWJxdWVyeS5jbGFzc05hbWUsIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIFJlY3Vyc2UgdG8gcmVwZWF0XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZU5vdEluUXVlcnkoKTtcbiAgfSk7XG59O1xuXG4vLyBVc2VkIHRvIGdldCB0aGUgZGVlcGVzdCBvYmplY3QgZnJvbSBqc29uIHVzaW5nIGRvdCBub3RhdGlvbi5cbmNvbnN0IGdldERlZXBlc3RPYmplY3RGcm9tS2V5ID0gKGpzb24sIGtleSwgaWR4LCBzcmMpID0+IHtcbiAgaWYgKGtleSBpbiBqc29uKSB7XG4gICAgcmV0dXJuIGpzb25ba2V5XTtcbiAgfVxuICBzcmMuc3BsaWNlKDEpOyAvLyBFeGl0IEVhcmx5XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1TZWxlY3QgPSAoc2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZShnZXREZWVwZXN0T2JqZWN0RnJvbUtleSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIHNlbGVjdE9iamVjdFsnJHNlbGVjdCddO1xuICBpZiAoQXJyYXkuaXNBcnJheShzZWxlY3RPYmplY3RbJyRpbiddKSkge1xuICAgIHNlbGVjdE9iamVjdFsnJGluJ10gPSBzZWxlY3RPYmplY3RbJyRpbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIHNlbGVjdE9iamVjdFsnJGluJ10gPSB2YWx1ZXM7XG4gIH1cbn07XG5cbi8vIFJlcGxhY2VzIGEgJHNlbGVjdCBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFcbi8vICRzZWxlY3QgY2xhdXNlLlxuLy8gVGhlICRzZWxlY3QgY2xhdXNlIHR1cm5zIGludG8gYW4gJGluIHdpdGggdmFsdWVzIHNlbGVjdGVkIG91dCBvZlxuLy8gdGhlIHN1YnF1ZXJ5LlxuLy8gUmV0dXJucyBhIHBvc3NpYmxlLXByb21pc2UuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VTZWxlY3QgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHNlbGVjdE9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJHNlbGVjdCcpO1xuICBpZiAoIXNlbGVjdE9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBzZWxlY3QgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHF1ZXJ5IGFuZCBrZXlcbiAgdmFyIHNlbGVjdFZhbHVlID0gc2VsZWN0T2JqZWN0Wyckc2VsZWN0J107XG4gIC8vIGlPUyBTREsgZG9uJ3Qgc2VuZCB3aGVyZSBpZiBub3Qgc2V0LCBsZXQgaXQgcGFzc1xuICBpZiAoXG4gICAgIXNlbGVjdFZhbHVlLnF1ZXJ5IHx8XG4gICAgIXNlbGVjdFZhbHVlLmtleSB8fFxuICAgIHR5cGVvZiBzZWxlY3RWYWx1ZS5xdWVyeSAhPT0gJ29iamVjdCcgfHxcbiAgICAhc2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lIHx8XG4gICAgT2JqZWN0LmtleXMoc2VsZWN0VmFsdWUpLmxlbmd0aCAhPT0gMlxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRzZWxlY3QnXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBzZWxlY3RWYWx1ZS5xdWVyeS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgc2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIHNlbGVjdFZhbHVlLnF1ZXJ5LndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtU2VsZWN0KHNlbGVjdE9iamVjdCwgc2VsZWN0VmFsdWUua2V5LCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkc2VsZWN0IGNsYXVzZXNcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlU2VsZWN0KCk7XG4gIH0pO1xufTtcblxuY29uc3QgdHJhbnNmb3JtRG9udFNlbGVjdCA9IChkb250U2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZShnZXREZWVwZXN0T2JqZWN0RnJvbUtleSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBkb250U2VsZWN0T2JqZWN0WyckbmluJ10gPSBkb250U2VsZWN0T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgZG9udFNlbGVjdE9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59O1xuXG4vLyBSZXBsYWNlcyBhICRkb250U2VsZWN0IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYVxuLy8gJGRvbnRTZWxlY3QgY2xhdXNlLlxuLy8gVGhlICRkb250U2VsZWN0IGNsYXVzZSB0dXJucyBpbnRvIGFuICRuaW4gd2l0aCB2YWx1ZXMgc2VsZWN0ZWQgb3V0IG9mXG4vLyB0aGUgc3VicXVlcnkuXG4vLyBSZXR1cm5zIGEgcG9zc2libGUtcHJvbWlzZS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZURvbnRTZWxlY3QgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGRvbnRTZWxlY3RPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRkb250U2VsZWN0Jyk7XG4gIGlmICghZG9udFNlbGVjdE9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBkb250U2VsZWN0IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSBxdWVyeSBhbmQga2V5XG4gIHZhciBkb250U2VsZWN0VmFsdWUgPSBkb250U2VsZWN0T2JqZWN0WyckZG9udFNlbGVjdCddO1xuICBpZiAoXG4gICAgIWRvbnRTZWxlY3RWYWx1ZS5xdWVyeSB8fFxuICAgICFkb250U2VsZWN0VmFsdWUua2V5IHx8XG4gICAgdHlwZW9mIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeSAhPT0gJ29iamVjdCcgfHxcbiAgICAhZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSB8fFxuICAgIE9iamVjdC5rZXlzKGRvbnRTZWxlY3RWYWx1ZSkubGVuZ3RoICE9PSAyXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJGRvbnRTZWxlY3QnXG4gICAgKTtcbiAgfVxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICB2YXIgc3VicXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuYXV0aCxcbiAgICBkb250U2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS53aGVyZSxcbiAgICBhZGRpdGlvbmFsT3B0aW9uc1xuICApO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHRyYW5zZm9ybURvbnRTZWxlY3QoXG4gICAgICBkb250U2VsZWN0T2JqZWN0LFxuICAgICAgZG9udFNlbGVjdFZhbHVlLmtleSxcbiAgICAgIHJlc3BvbnNlLnJlc3VsdHNcbiAgICApO1xuICAgIC8vIEtlZXAgcmVwbGFjaW5nICRkb250U2VsZWN0IGNsYXVzZXNcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlRG9udFNlbGVjdCgpO1xuICB9KTtcbn07XG5cbmNvbnN0IGNsZWFuUmVzdWx0QXV0aERhdGEgPSBmdW5jdGlvbihyZXN1bHQpIHtcbiAgZGVsZXRlIHJlc3VsdC5wYXNzd29yZDtcbiAgaWYgKHJlc3VsdC5hdXRoRGF0YSkge1xuICAgIE9iamVjdC5rZXlzKHJlc3VsdC5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICBpZiAocmVzdWx0LmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICBkZWxldGUgcmVzdWx0LmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmIChPYmplY3Qua2V5cyhyZXN1bHQuYXV0aERhdGEpLmxlbmd0aCA9PSAwKSB7XG4gICAgICBkZWxldGUgcmVzdWx0LmF1dGhEYXRhO1xuICAgIH1cbiAgfVxufTtcblxuY29uc3QgcmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCA9IGNvbnN0cmFpbnQgPT4ge1xuICBpZiAodHlwZW9mIGNvbnN0cmFpbnQgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIGNvbnN0cmFpbnQ7XG4gIH1cbiAgY29uc3QgZXF1YWxUb09iamVjdCA9IHt9O1xuICBsZXQgaGFzRGlyZWN0Q29uc3RyYWludCA9IGZhbHNlO1xuICBsZXQgaGFzT3BlcmF0b3JDb25zdHJhaW50ID0gZmFsc2U7XG4gIGZvciAoY29uc3Qga2V5IGluIGNvbnN0cmFpbnQpIHtcbiAgICBpZiAoa2V5LmluZGV4T2YoJyQnKSAhPT0gMCkge1xuICAgICAgaGFzRGlyZWN0Q29uc3RyYWludCA9IHRydWU7XG4gICAgICBlcXVhbFRvT2JqZWN0W2tleV0gPSBjb25zdHJhaW50W2tleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGhhc09wZXJhdG9yQ29uc3RyYWludCA9IHRydWU7XG4gICAgfVxuICB9XG4gIGlmIChoYXNEaXJlY3RDb25zdHJhaW50ICYmIGhhc09wZXJhdG9yQ29uc3RyYWludCkge1xuICAgIGNvbnN0cmFpbnRbJyRlcSddID0gZXF1YWxUb09iamVjdDtcbiAgICBPYmplY3Qua2V5cyhlcXVhbFRvT2JqZWN0KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBkZWxldGUgY29uc3RyYWludFtrZXldO1xuICAgIH0pO1xuICB9XG4gIHJldHVybiBjb25zdHJhaW50O1xufTtcblxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlRXF1YWxpdHkgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHR5cGVvZiB0aGlzLnJlc3RXaGVyZSAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5yZXN0V2hlcmUpIHtcbiAgICB0aGlzLnJlc3RXaGVyZVtrZXldID0gcmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCh0aGlzLnJlc3RXaGVyZVtrZXldKTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZXRoZXIgaXQgd2FzIHN1Y2Nlc3NmdWwuXG4vLyBQb3B1bGF0ZXMgdGhpcy5yZXNwb25zZSB3aXRoIGFuIG9iamVjdCB0aGF0IG9ubHkgaGFzICdyZXN1bHRzJy5cblJlc3RRdWVyeS5wcm90b3R5cGUucnVuRmluZCA9IGZ1bmN0aW9uKG9wdGlvbnMgPSB7fSkge1xuICBpZiAodGhpcy5maW5kT3B0aW9ucy5saW1pdCA9PT0gMCkge1xuICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3VsdHM6IFtdIH07XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIGNvbnN0IGZpbmRPcHRpb25zID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5maW5kT3B0aW9ucyk7XG4gIGlmICh0aGlzLmtleXMpIHtcbiAgICBmaW5kT3B0aW9ucy5rZXlzID0gdGhpcy5rZXlzLm1hcChrZXkgPT4ge1xuICAgICAgcmV0dXJuIGtleS5zcGxpdCgnLicpWzBdO1xuICAgIH0pO1xuICB9XG4gIGlmIChvcHRpb25zLm9wKSB7XG4gICAgZmluZE9wdGlvbnMub3AgPSBvcHRpb25zLm9wO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJlc3RXaGVyZSwgZmluZE9wdGlvbnMsIHRoaXMuYXV0aClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgICBmb3IgKHZhciByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgICAgICAgIGNsZWFuUmVzdWx0QXV0aERhdGEocmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdCh0aGlzLmNvbmZpZywgcmVzdWx0cyk7XG5cbiAgICAgIGlmICh0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lKSB7XG4gICAgICAgIGZvciAodmFyIHIgb2YgcmVzdWx0cykge1xuICAgICAgICAgIHIuY2xhc3NOYW1lID0gdGhpcy5yZWRpcmVjdENsYXNzTmFtZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdGhpcy5yZXNwb25zZSA9IHsgcmVzdWx0czogcmVzdWx0cyB9O1xuICAgIH0pO1xufTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZXRoZXIgaXQgd2FzIHN1Y2Nlc3NmdWwuXG4vLyBQb3B1bGF0ZXMgdGhpcy5yZXNwb25zZS5jb3VudCB3aXRoIHRoZSBjb3VudFxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5ydW5Db3VudCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuZG9Db3VudCkge1xuICAgIHJldHVybjtcbiAgfVxuICB0aGlzLmZpbmRPcHRpb25zLmNvdW50ID0gdHJ1ZTtcbiAgZGVsZXRlIHRoaXMuZmluZE9wdGlvbnMuc2tpcDtcbiAgZGVsZXRlIHRoaXMuZmluZE9wdGlvbnMubGltaXQ7XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJlc3RXaGVyZSwgdGhpcy5maW5kT3B0aW9ucylcbiAgICAudGhlbihjID0+IHtcbiAgICAgIHRoaXMucmVzcG9uc2UuY291bnQgPSBjO1xuICAgIH0pO1xufTtcblxuLy8gQXVnbWVudHMgdGhpcy5yZXNwb25zZSB3aXRoIGFsbCBwb2ludGVycyBvbiBhbiBvYmplY3RcblJlc3RRdWVyeS5wcm90b3R5cGUuaGFuZGxlSW5jbHVkZUFsbCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuaW5jbHVkZUFsbCkge1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAubG9hZFNjaGVtYSgpXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYSh0aGlzLmNsYXNzTmFtZSkpXG4gICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgIGNvbnN0IGluY2x1ZGVGaWVsZHMgPSBbXTtcbiAgICAgIGNvbnN0IGtleUZpZWxkcyA9IFtdO1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBzY2hlbWEuZmllbGRzKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlICYmXG4gICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1BvaW50ZXInXG4gICAgICAgICkge1xuICAgICAgICAgIGluY2x1ZGVGaWVsZHMucHVzaChbZmllbGRdKTtcbiAgICAgICAgICBrZXlGaWVsZHMucHVzaChmaWVsZCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIEFkZCBmaWVsZHMgdG8gaW5jbHVkZSwga2V5cywgcmVtb3ZlIGR1cHNcbiAgICAgIHRoaXMuaW5jbHVkZSA9IFsuLi5uZXcgU2V0KFsuLi50aGlzLmluY2x1ZGUsIC4uLmluY2x1ZGVGaWVsZHNdKV07XG4gICAgICAvLyBpZiB0aGlzLmtleXMgbm90IHNldCwgdGhlbiBhbGwga2V5cyBhcmUgYWxyZWFkeSBpbmNsdWRlZFxuICAgICAgaWYgKHRoaXMua2V5cykge1xuICAgICAgICB0aGlzLmtleXMgPSBbLi4ubmV3IFNldChbLi4udGhpcy5rZXlzLCAuLi5rZXlGaWVsZHNdKV07XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG4vLyBVcGRhdGVzIHByb3BlcnR5IGB0aGlzLmtleXNgIHRvIGNvbnRhaW4gYWxsIGtleXMgYnV0IHRoZSBvbmVzIHVuc2VsZWN0ZWQuXG5SZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUV4Y2x1ZGVLZXlzID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5leGNsdWRlS2V5cykge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGhpcy5rZXlzKSB7XG4gICAgdGhpcy5rZXlzID0gdGhpcy5rZXlzLmZpbHRlcihrID0+ICF0aGlzLmV4Y2x1ZGVLZXlzLmluY2x1ZGVzKGspKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmxvYWRTY2hlbWEoKVxuICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEodGhpcy5jbGFzc05hbWUpKVxuICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICBjb25zdCBmaWVsZHMgPSBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKTtcbiAgICAgIHRoaXMua2V5cyA9IGZpZWxkcy5maWx0ZXIoayA9PiAhdGhpcy5leGNsdWRlS2V5cy5pbmNsdWRlcyhrKSk7XG4gICAgfSk7XG59O1xuXG4vLyBBdWdtZW50cyB0aGlzLnJlc3BvbnNlIHdpdGggZGF0YSBhdCB0aGUgcGF0aHMgcHJvdmlkZWQgaW4gdGhpcy5pbmNsdWRlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVJbmNsdWRlID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmluY2x1ZGUubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgcGF0aFJlc3BvbnNlID0gaW5jbHVkZVBhdGgoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIHRoaXMucmVzcG9uc2UsXG4gICAgdGhpcy5pbmNsdWRlWzBdLFxuICAgIHRoaXMucmVzdE9wdGlvbnNcbiAgKTtcbiAgaWYgKHBhdGhSZXNwb25zZS50aGVuKSB7XG4gICAgcmV0dXJuIHBhdGhSZXNwb25zZS50aGVuKG5ld1Jlc3BvbnNlID0+IHtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSBuZXdSZXNwb25zZTtcbiAgICAgIHRoaXMuaW5jbHVkZSA9IHRoaXMuaW5jbHVkZS5zbGljZSgxKTtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGUoKTtcbiAgICB9KTtcbiAgfSBlbHNlIGlmICh0aGlzLmluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgIHRoaXMuaW5jbHVkZSA9IHRoaXMuaW5jbHVkZS5zbGljZSgxKTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVJbmNsdWRlKCk7XG4gIH1cblxuICByZXR1cm4gcGF0aFJlc3BvbnNlO1xufTtcblxuLy9SZXR1cm5zIGEgcHJvbWlzZSBvZiBhIHByb2Nlc3NlZCBzZXQgb2YgcmVzdWx0c1xuUmVzdFF1ZXJ5LnByb3RvdHlwZS5ydW5BZnRlckZpbmRUcmlnZ2VyID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXRoaXMucnVuQWZ0ZXJGaW5kKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyRmluZCcgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJGaW5kSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgaWYgKCFoYXNBZnRlckZpbmRIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFNraXAgQWdncmVnYXRlIGFuZCBEaXN0aW5jdCBRdWVyaWVzXG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLnBpcGVsaW5lIHx8IHRoaXMuZmluZE9wdGlvbnMuZGlzdGluY3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gUnVuIGFmdGVyRmluZCB0cmlnZ2VyIGFuZCBzZXQgdGhlIG5ldyByZXN1bHRzXG4gIHJldHVybiB0cmlnZ2Vyc1xuICAgIC5tYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlckZpbmQsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyxcbiAgICAgIHRoaXMuY29uZmlnXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgLy8gRW5zdXJlIHdlIHByb3Blcmx5IHNldCB0aGUgY2xhc3NOYW1lIGJhY2tcbiAgICAgIGlmICh0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lKSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkge1xuICAgICAgICAgICAgb2JqZWN0ID0gb2JqZWN0LnRvSlNPTigpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3QuY2xhc3NOYW1lID0gdGhpcy5yZWRpcmVjdENsYXNzTmFtZTtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0O1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHM7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG4vLyBBZGRzIGluY2x1ZGVkIHZhbHVlcyB0byB0aGUgcmVzcG9uc2UuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZCBuYW1lcy5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhbiBhdWdtZW50ZWQgcmVzcG9uc2UuXG5mdW5jdGlvbiBpbmNsdWRlUGF0aChjb25maWcsIGF1dGgsIHJlc3BvbnNlLCBwYXRoLCByZXN0T3B0aW9ucyA9IHt9KSB7XG4gIHZhciBwb2ludGVycyA9IGZpbmRQb2ludGVycyhyZXNwb25zZS5yZXN1bHRzLCBwYXRoKTtcbiAgaWYgKHBvaW50ZXJzLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG4gIGNvbnN0IHBvaW50ZXJzSGFzaCA9IHt9O1xuICBmb3IgKHZhciBwb2ludGVyIG9mIHBvaW50ZXJzKSB7XG4gICAgaWYgKCFwb2ludGVyKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NOYW1lID0gcG9pbnRlci5jbGFzc05hbWU7XG4gICAgLy8gb25seSBpbmNsdWRlIHRoZSBnb29kIHBvaW50ZXJzXG4gICAgaWYgKGNsYXNzTmFtZSkge1xuICAgICAgcG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0gPSBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSB8fCBuZXcgU2V0KCk7XG4gICAgICBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXS5hZGQocG9pbnRlci5vYmplY3RJZCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IGluY2x1ZGVSZXN0T3B0aW9ucyA9IHt9O1xuICBpZiAocmVzdE9wdGlvbnMua2V5cykge1xuICAgIGNvbnN0IGtleXMgPSBuZXcgU2V0KHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKSk7XG4gICAgY29uc3Qga2V5U2V0ID0gQXJyYXkuZnJvbShrZXlzKS5yZWR1Y2UoKHNldCwga2V5KSA9PiB7XG4gICAgICBjb25zdCBrZXlQYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgICBsZXQgaSA9IDA7XG4gICAgICBmb3IgKGk7IGkgPCBwYXRoLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChwYXRoW2ldICE9IGtleVBhdGhbaV0pIHtcbiAgICAgICAgICByZXR1cm4gc2V0O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoaSA8IGtleVBhdGgubGVuZ3RoKSB7XG4gICAgICAgIHNldC5hZGQoa2V5UGF0aFtpXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2V0O1xuICAgIH0sIG5ldyBTZXQoKSk7XG4gICAgaWYgKGtleVNldC5zaXplID4gMCkge1xuICAgICAgaW5jbHVkZVJlc3RPcHRpb25zLmtleXMgPSBBcnJheS5mcm9tKGtleVNldCkuam9pbignLCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgaW5jbHVkZVJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9XG4gICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAocmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXJ5UHJvbWlzZXMgPSBPYmplY3Qua2V5cyhwb2ludGVyc0hhc2gpLm1hcChjbGFzc05hbWUgPT4ge1xuICAgIGNvbnN0IG9iamVjdElkcyA9IEFycmF5LmZyb20ocG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0pO1xuICAgIGxldCB3aGVyZTtcbiAgICBpZiAob2JqZWN0SWRzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgd2hlcmUgPSB7IG9iamVjdElkOiBvYmplY3RJZHNbMF0gfTtcbiAgICB9IGVsc2Uge1xuICAgICAgd2hlcmUgPSB7IG9iamVjdElkOiB7ICRpbjogb2JqZWN0SWRzIH0gfTtcbiAgICB9XG4gICAgdmFyIHF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICAgIGNvbmZpZyxcbiAgICAgIGF1dGgsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICB3aGVyZSxcbiAgICAgIGluY2x1ZGVSZXN0T3B0aW9uc1xuICAgICk7XG4gICAgcmV0dXJuIHF1ZXJ5LmV4ZWN1dGUoeyBvcDogJ2dldCcgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXN1bHRzKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gR2V0IHRoZSBvYmplY3RzIGZvciBhbGwgdGhlc2Ugb2JqZWN0IGlkc1xuICByZXR1cm4gUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcykudGhlbihyZXNwb25zZXMgPT4ge1xuICAgIHZhciByZXBsYWNlID0gcmVzcG9uc2VzLnJlZHVjZSgocmVwbGFjZSwgaW5jbHVkZVJlc3BvbnNlKSA9PiB7XG4gICAgICBmb3IgKHZhciBvYmogb2YgaW5jbHVkZVJlc3BvbnNlLnJlc3VsdHMpIHtcbiAgICAgICAgb2JqLl9fdHlwZSA9ICdPYmplY3QnO1xuICAgICAgICBvYmouY2xhc3NOYW1lID0gaW5jbHVkZVJlc3BvbnNlLmNsYXNzTmFtZTtcblxuICAgICAgICBpZiAob2JqLmNsYXNzTmFtZSA9PSAnX1VzZXInICYmICFhdXRoLmlzTWFzdGVyKSB7XG4gICAgICAgICAgZGVsZXRlIG9iai5zZXNzaW9uVG9rZW47XG4gICAgICAgICAgZGVsZXRlIG9iai5hdXRoRGF0YTtcbiAgICAgICAgfVxuICAgICAgICByZXBsYWNlW29iai5vYmplY3RJZF0gPSBvYmo7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVwbGFjZTtcbiAgICB9LCB7fSk7XG5cbiAgICB2YXIgcmVzcCA9IHtcbiAgICAgIHJlc3VsdHM6IHJlcGxhY2VQb2ludGVycyhyZXNwb25zZS5yZXN1bHRzLCBwYXRoLCByZXBsYWNlKSxcbiAgICB9O1xuICAgIGlmIChyZXNwb25zZS5jb3VudCkge1xuICAgICAgcmVzcC5jb3VudCA9IHJlc3BvbnNlLmNvdW50O1xuICAgIH1cbiAgICByZXR1cm4gcmVzcDtcbiAgfSk7XG59XG5cbi8vIE9iamVjdCBtYXkgYmUgYSBsaXN0IG9mIFJFU1QtZm9ybWF0IG9iamVjdCB0byBmaW5kIHBvaW50ZXJzIGluLCBvclxuLy8gaXQgbWF5IGJlIGEgc2luZ2xlIG9iamVjdC5cbi8vIElmIHRoZSBwYXRoIHlpZWxkcyB0aGluZ3MgdGhhdCBhcmVuJ3QgcG9pbnRlcnMsIHRoaXMgdGhyb3dzIGFuIGVycm9yLlxuLy8gUGF0aCBpcyBhIGxpc3Qgb2YgZmllbGRzIHRvIHNlYXJjaCBpbnRvLlxuLy8gUmV0dXJucyBhIGxpc3Qgb2YgcG9pbnRlcnMgaW4gUkVTVCBmb3JtYXQuXG5mdW5jdGlvbiBmaW5kUG9pbnRlcnMob2JqZWN0LCBwYXRoKSB7XG4gIGlmIChvYmplY3QgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgIHZhciBhbnN3ZXIgPSBbXTtcbiAgICBmb3IgKHZhciB4IG9mIG9iamVjdCkge1xuICAgICAgYW5zd2VyID0gYW5zd2VyLmNvbmNhdChmaW5kUG9pbnRlcnMoeCwgcGF0aCkpO1xuICAgIH1cbiAgICByZXR1cm4gYW5zd2VyO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvYmplY3QgIT09ICdvYmplY3QnIHx8ICFvYmplY3QpIHtcbiAgICByZXR1cm4gW107XG4gIH1cblxuICBpZiAocGF0aC5sZW5ndGggPT0gMCkge1xuICAgIGlmIChvYmplY3QgPT09IG51bGwgfHwgb2JqZWN0Ll9fdHlwZSA9PSAnUG9pbnRlcicpIHtcbiAgICAgIHJldHVybiBbb2JqZWN0XTtcbiAgICB9XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgdmFyIHN1Ym9iamVjdCA9IG9iamVjdFtwYXRoWzBdXTtcbiAgaWYgKCFzdWJvYmplY3QpIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgcmV0dXJuIGZpbmRQb2ludGVycyhzdWJvYmplY3QsIHBhdGguc2xpY2UoMSkpO1xufVxuXG4vLyBPYmplY3QgbWF5IGJlIGEgbGlzdCBvZiBSRVNULWZvcm1hdCBvYmplY3RzIHRvIHJlcGxhY2UgcG9pbnRlcnNcbi8vIGluLCBvciBpdCBtYXkgYmUgYSBzaW5nbGUgb2JqZWN0LlxuLy8gUGF0aCBpcyBhIGxpc3Qgb2YgZmllbGRzIHRvIHNlYXJjaCBpbnRvLlxuLy8gcmVwbGFjZSBpcyBhIG1hcCBmcm9tIG9iamVjdCBpZCAtPiBvYmplY3QuXG4vLyBSZXR1cm5zIHNvbWV0aGluZyBhbmFsb2dvdXMgdG8gb2JqZWN0LCBidXQgd2l0aCB0aGUgYXBwcm9wcmlhdGVcbi8vIHBvaW50ZXJzIGluZmxhdGVkLlxuZnVuY3Rpb24gcmVwbGFjZVBvaW50ZXJzKG9iamVjdCwgcGF0aCwgcmVwbGFjZSkge1xuICBpZiAob2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICByZXR1cm4gb2JqZWN0XG4gICAgICAubWFwKG9iaiA9PiByZXBsYWNlUG9pbnRlcnMob2JqLCBwYXRoLCByZXBsYWNlKSlcbiAgICAgIC5maWx0ZXIob2JqID0+IHR5cGVvZiBvYmogIT09ICd1bmRlZmluZWQnKTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIGlmIChwYXRoLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChvYmplY3QgJiYgb2JqZWN0Ll9fdHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gcmVwbGFjZVtvYmplY3Qub2JqZWN0SWRdO1xuICAgIH1cbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgdmFyIHN1Ym9iamVjdCA9IG9iamVjdFtwYXRoWzBdXTtcbiAgaWYgKCFzdWJvYmplY3QpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIHZhciBuZXdzdWIgPSByZXBsYWNlUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpLCByZXBsYWNlKTtcbiAgdmFyIGFuc3dlciA9IHt9O1xuICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgaWYgKGtleSA9PSBwYXRoWzBdKSB7XG4gICAgICBhbnN3ZXJba2V5XSA9IG5ld3N1YjtcbiAgICB9IGVsc2Uge1xuICAgICAgYW5zd2VyW2tleV0gPSBvYmplY3Rba2V5XTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGFuc3dlcjtcbn1cblxuLy8gRmluZHMgYSBzdWJvYmplY3QgdGhhdCBoYXMgdGhlIGdpdmVuIGtleSwgaWYgdGhlcmUgaXMgb25lLlxuLy8gUmV0dXJucyB1bmRlZmluZWQgb3RoZXJ3aXNlLlxuZnVuY3Rpb24gZmluZE9iamVjdFdpdGhLZXkocm9vdCwga2V5KSB7XG4gIGlmICh0eXBlb2Ygcm9vdCAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHJvb3QgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgIGZvciAodmFyIGl0ZW0gb2Ygcm9vdCkge1xuICAgICAgY29uc3QgYW5zd2VyID0gZmluZE9iamVjdFdpdGhLZXkoaXRlbSwga2V5KTtcbiAgICAgIGlmIChhbnN3ZXIpIHtcbiAgICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKHJvb3QgJiYgcm9vdFtrZXldKSB7XG4gICAgcmV0dXJuIHJvb3Q7XG4gIH1cbiAgZm9yICh2YXIgc3Via2V5IGluIHJvb3QpIHtcbiAgICBjb25zdCBhbnN3ZXIgPSBmaW5kT2JqZWN0V2l0aEtleShyb290W3N1YmtleV0sIGtleSk7XG4gICAgaWYgKGFuc3dlcikge1xuICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdHJhY2VQcm9taXNlKG9wZXJhdGlvbiwgY2xhc3NOYW1lLCBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCkpIHtcbiAgY29uc3QgcGFyZW50ID0gQVdTWFJheS5nZXRTZWdtZW50KCk7XG4gIGlmICghcGFyZW50KSB7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBBV1NYUmF5LmNhcHR1cmVBc3luY0Z1bmMoXG4gICAgICBgUGFyc2UtU2VydmVyX1Jlc3RRdWVyeV8ke29wZXJhdGlvbn1fJHtjbGFzc05hbWV9YCxcbiAgICAgIHN1YnNlZ21lbnQgPT4ge1xuICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ29udHJvbGxlcicsICdSZXN0UXVlcnknKTtcbiAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ09wZXJhdGlvbicsIG9wZXJhdGlvbik7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDbGFzc05hbWUnLCBjbGFzc05hbWUpO1xuICAgICAgICAocHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UgPyBwcm9taXNlIDogUHJvbWlzZS5yZXNvbHZlKHByb21pc2UpKS50aGVuKFxuICAgICAgICAgIGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBmdW5jdGlvbihlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5jbG9zZShlcnJvcik7XG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgfVxuICAgICk7XG4gIH0pO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IFJlc3RRdWVyeTtcbiJdfQ==