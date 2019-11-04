"use strict";

var _node = require("parse/node");

var _lodash = _interopRequireDefault(require("lodash"));

var _intersect = _interopRequireDefault(require("intersect"));

var _deepcopy = _interopRequireDefault(require("deepcopy"));

var _logger = _interopRequireDefault(require("../logger"));

var SchemaController = _interopRequireWildcard(require("./SchemaController"));

var _StorageAdapter = require("../Adapters/Storage/StorageAdapter");

var _awsXraySdk = _interopRequireDefault(require("aws-xray-sdk"));

function _getRequireWildcardCache() { if (typeof WeakMap !== "function") return null; var cache = new WeakMap(); _getRequireWildcardCache = function () { return cache; }; return cache; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } var cache = _getRequireWildcardCache(); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; if (obj != null) { var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(source, true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function _objectWithoutProperties(source, excluded) { if (source == null) return {}; var target = _objectWithoutPropertiesLoose(source, excluded); var key, i; if (Object.getOwnPropertySymbols) { var sourceSymbolKeys = Object.getOwnPropertySymbols(source); for (i = 0; i < sourceSymbolKeys.length; i++) { key = sourceSymbolKeys[i]; if (excluded.indexOf(key) >= 0) continue; if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue; target[key] = source[key]; } } return target; }

function _objectWithoutPropertiesLoose(source, excluded) { if (source == null) return {}; var target = {}; var sourceKeys = Object.keys(source); var key, i; for (i = 0; i < sourceKeys.length; i++) { key = sourceKeys[i]; if (excluded.indexOf(key) >= 0) continue; target[key] = source[key]; } return target; }

function addWriteACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query); //Can't be any existing '_wperm' query, we don't allow client queries on that, no need to $and


  newQuery._wperm = {
    $in: [null, ...acl]
  };
  return newQuery;
}

function addReadACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query); //Can't be any existing '_rperm' query, we don't allow client queries on that, no need to $and


  newQuery._rperm = {
    $in: [null, '*', ...acl]
  };
  return newQuery;
} // Transforms a REST API formatted ACL object to our two-field mongo format.


const transformObjectACL = (_ref) => {
  let {
    ACL
  } = _ref,
      result = _objectWithoutProperties(_ref, ["ACL"]);

  if (!ACL) {
    return result;
  }

  result._wperm = [];
  result._rperm = [];

  for (const entry in ACL) {
    if (ACL[entry].read) {
      result._rperm.push(entry);
    }

    if (ACL[entry].write) {
      result._wperm.push(entry);
    }
  }

  return result;
};

const specialQuerykeys = ['$and', '$or', '$nor', '_rperm', '_wperm', '_perishable_token', '_email_verify_token', '_email_verify_token_expires_at', '_account_lockout_expires_at', '_failed_login_count'];

const isSpecialQueryKey = key => {
  return specialQuerykeys.indexOf(key) >= 0;
};

const validateQuery = (query, skipMongoDBServer13732Workaround) => {
  if (query.ACL) {
    throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Cannot query on ACL.');
  }

  if (query.$or) {
    if (query.$or instanceof Array) {
      query.$or.forEach(el => validateQuery(el, skipMongoDBServer13732Workaround));

      if (!skipMongoDBServer13732Workaround) {
        /* In MongoDB 3.2 & 3.4, $or queries which are not alone at the top
         * level of the query can not make efficient use of indexes due to a
         * long standing bug known as SERVER-13732.
         *
         * This bug was fixed in MongoDB version 3.6.
         *
         * For versions pre-3.6, the below logic produces a substantial
         * performance improvement inside the database by avoiding the bug.
         *
         * For versions 3.6 and above, there is no performance improvement and
         * the logic is unnecessary. Some query patterns are even slowed by
         * the below logic, due to the bug having been fixed and better
         * query plans being chosen.
         *
         * When versions before 3.4 are no longer supported by this project,
         * this logic, and the accompanying `skipMongoDBServer13732Workaround`
         * flag, can be removed.
         *
         * This block restructures queries in which $or is not the sole top
         * level element by moving all other top-level predicates inside every
         * subdocument of the $or predicate, allowing MongoDB's query planner
         * to make full use of the most relevant indexes.
         *
         * EG:      {$or: [{a: 1}, {a: 2}], b: 2}
         * Becomes: {$or: [{a: 1, b: 2}, {a: 2, b: 2}]}
         *
         * The only exceptions are $near and $nearSphere operators, which are
         * constrained to only 1 operator per query. As a result, these ops
         * remain at the top level
         *
         * https://jira.mongodb.org/browse/SERVER-13732
         * https://github.com/parse-community/parse-server/issues/3767
         */
        Object.keys(query).forEach(key => {
          const noCollisions = !query.$or.some(subq => Object.prototype.hasOwnProperty.call(subq, key));
          let hasNears = false;

          if (query[key] != null && typeof query[key] == 'object') {
            hasNears = '$near' in query[key] || '$nearSphere' in query[key];
          }

          if (key != '$or' && noCollisions && !hasNears) {
            query.$or.forEach(subquery => {
              subquery[key] = query[key];
            });
            delete query[key];
          }
        });
        query.$or.forEach(el => validateQuery(el, skipMongoDBServer13732Workaround));
      }
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $or format - use an array value.');
    }
  }

  if (query.$and) {
    if (query.$and instanceof Array) {
      query.$and.forEach(el => validateQuery(el, skipMongoDBServer13732Workaround));
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $and format - use an array value.');
    }
  }

  if (query.$nor) {
    if (query.$nor instanceof Array && query.$nor.length > 0) {
      query.$nor.forEach(el => validateQuery(el, skipMongoDBServer13732Workaround));
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $nor format - use an array of at least 1 value.');
    }
  }

  Object.keys(query).forEach(key => {
    if (query && query[key] && query[key].$regex) {
      if (typeof query[key].$options === 'string') {
        if (!query[key].$options.match(/^[imxs]+$/)) {
          throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Bad $options value for query: ${query[key].$options}`);
        }
      }
    }

    if (!isSpecialQueryKey(key) && !key.match(/^[a-zA-Z][a-zA-Z0-9_\.]*$/)) {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid key name: ${key}`);
    }
  });
}; // Filters out any data that shouldn't be on this REST-formatted object.


const filterSensitiveData = (isMaster, aclGroup, auth, operation, schema, className, protectedFields, object) => {
  let userId = null;
  if (auth && auth.user) userId = auth.user.id; // replace protectedFields when using pointer-permissions

  const perms = schema.getClassLevelPermissions(className);

  if (perms) {
    const isReadOperation = ['get', 'find'].indexOf(operation) > -1;

    if (isReadOperation && perms.protectedFields) {
      // extract protectedFields added with the pointer-permission prefix
      const protectedFieldsPointerPerm = Object.keys(perms.protectedFields).filter(key => key.startsWith('userField:')).map(key => {
        return {
          key: key.substring(10),
          value: perms.protectedFields[key]
        };
      });
      const newProtectedFields = [];
      let overrideProtectedFields = false; // check if the object grants the current user access based on the extracted fields

      protectedFieldsPointerPerm.forEach(pointerPerm => {
        let pointerPermIncludesUser = false;
        const readUserFieldValue = object[pointerPerm.key];

        if (readUserFieldValue) {
          if (Array.isArray(readUserFieldValue)) {
            pointerPermIncludesUser = readUserFieldValue.some(user => user.objectId && user.objectId === userId);
          } else {
            pointerPermIncludesUser = readUserFieldValue.objectId && readUserFieldValue.objectId === userId;
          }
        }

        if (pointerPermIncludesUser) {
          overrideProtectedFields = true;
          newProtectedFields.push(...pointerPerm.value);
        }
      }); // if atleast one pointer-permission affected the current user override the protectedFields

      if (overrideProtectedFields) protectedFields = newProtectedFields;
    }
  }

  const isUserClass = className === '_User';
  /* special treat for the user class: don't filter protectedFields if currently loggedin user is
  the retrieved user */

  if (!(isUserClass && userId && object.objectId === userId)) protectedFields && protectedFields.forEach(k => delete object[k]);

  if (!isUserClass) {
    return object;
  }

  object.password = object._hashed_password;
  delete object._hashed_password;
  delete object.sessionToken;

  if (isMaster) {
    return object;
  }

  delete object._email_verify_token;
  delete object._perishable_token;
  delete object._perishable_token_expires_at;
  delete object._tombstone;
  delete object._email_verify_token_expires_at;
  delete object._failed_login_count;
  delete object._account_lockout_expires_at;
  delete object._password_changed_at;
  delete object._password_history;

  if (aclGroup.indexOf(object.objectId) > -1) {
    return object;
  }

  delete object.authData;
  return object;
};

// Runs an update on the database.
// Returns a promise for an object with the new values for field
// modifications that don't know their results ahead of time, like
// 'increment'.
// Options:
//   acl:  a list of strings. If the object to be updated has an ACL,
//         one of the provided strings must provide the caller with
//         write permissions.
const specialKeysForUpdate = ['_hashed_password', '_perishable_token', '_email_verify_token', '_email_verify_token_expires_at', '_account_lockout_expires_at', '_failed_login_count', '_perishable_token_expires_at', '_password_changed_at', '_password_history'];

const isSpecialUpdateKey = key => {
  return specialKeysForUpdate.indexOf(key) >= 0;
};

function expandResultOnKeyPath(object, key, value) {
  if (key.indexOf('.') < 0) {
    object[key] = value[key];
    return object;
  }

  const path = key.split('.');
  const firstKey = path[0];
  const nextPath = path.slice(1).join('.');
  object[firstKey] = expandResultOnKeyPath(object[firstKey] || {}, nextPath, value[firstKey]);
  delete object[key];
  return object;
}

function sanitizeDatabaseResult(originalObject, result) {
  const response = {};

  if (!result) {
    return Promise.resolve(response);
  }

  Object.keys(originalObject).forEach(key => {
    const keyUpdate = originalObject[key]; // determine if that was an op

    if (keyUpdate && typeof keyUpdate === 'object' && keyUpdate.__op && ['Add', 'AddUnique', 'Remove', 'Increment'].indexOf(keyUpdate.__op) > -1) {
      // only valid ops that produce an actionable result
      // the op may have happend on a keypath
      expandResultOnKeyPath(response, key, result);
    }
  });
  return Promise.resolve(response);
}

function joinTableName(className, key) {
  return `_Join:${key}:${className}`;
}

const flattenUpdateOperatorsForCreate = object => {
  for (const key in object) {
    if (object[key] && object[key].__op) {
      switch (object[key].__op) {
        case 'Increment':
          if (typeof object[key].amount !== 'number') {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].amount;
          break;

        case 'Add':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].objects;
          break;

        case 'AddUnique':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].objects;
          break;

        case 'Remove':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = [];
          break;

        case 'Delete':
          delete object[key];
          break;

        default:
          throw new _node.Parse.Error(_node.Parse.Error.COMMAND_UNAVAILABLE, `The ${object[key].__op} operator is not supported yet.`);
      }
    }
  }
};

const transformAuthData = (className, object, schema) => {
  if (object.authData && className === '_User') {
    Object.keys(object.authData).forEach(provider => {
      const providerData = object.authData[provider];
      const fieldName = `_auth_data_${provider}`;

      if (providerData == null) {
        object[fieldName] = {
          __op: 'Delete'
        };
      } else {
        object[fieldName] = providerData;
        schema.fields[fieldName] = {
          type: 'Object'
        };
      }
    });
    delete object.authData;
  }
}; // Transforms a Database format ACL to a REST API format ACL


const untransformObjectACL = (_ref2) => {
  let {
    _rperm,
    _wperm
  } = _ref2,
      output = _objectWithoutProperties(_ref2, ["_rperm", "_wperm"]);

  if (_rperm || _wperm) {
    output.ACL = {};

    (_rperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          read: true
        };
      } else {
        output.ACL[entry]['read'] = true;
      }
    });

    (_wperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          write: true
        };
      } else {
        output.ACL[entry]['write'] = true;
      }
    });
  }

  return output;
};
/**
 * When querying, the fieldName may be compound, extract the root fieldName
 *     `temperature.celsius` becomes `temperature`
 * @param {string} fieldName that may be a compound field name
 * @returns {string} the root name of the field
 */


const getRootFieldName = fieldName => {
  return fieldName.split('.')[0];
};

const relationSchema = {
  fields: {
    relatedId: {
      type: 'String'
    },
    owningId: {
      type: 'String'
    }
  }
};

class DatabaseController {
  constructor(adapter, schemaCache, skipMongoDBServer13732Workaround) {
    this.adapter = adapter;
    this.schemaCache = schemaCache; // We don't want a mutable this.schema, because then you could have
    // one request that uses different schemas for different parts of
    // it. Instead, use loadSchema to get a schema.

    this.schemaPromise = null;
    this.skipMongoDBServer13732Workaround = skipMongoDBServer13732Workaround;
    this._transactionalSession = null;
  }

  collectionExists(className) {
    return this.adapter.classExists(className);
  }

  purgeCollection(className) {
    return this.loadSchema().then(schemaController => schemaController.getOneSchema(className)).then(schema => this.adapter.deleteObjectsByQuery(className, schema, {}));
  }

  validateClassName(className) {
    if (!SchemaController.classNameIsValid(className)) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_CLASS_NAME, 'invalid className: ' + className));
    }

    return Promise.resolve();
  } // Returns a promise for a schemaController.


  loadSchema(options = {
    clearCache: false
  }) {
    if (this.schemaPromise != null) {
      return this.schemaPromise;
    }

    this.schemaPromise = SchemaController.load(this.adapter, this.schemaCache, options);
    this.schemaPromise.then(() => delete this.schemaPromise, () => delete this.schemaPromise);
    return this.loadSchema(options);
  }

  loadSchemaIfNeeded(schemaController, options = {
    clearCache: false
  }) {
    return schemaController ? Promise.resolve(schemaController) : this.loadSchema(options);
  } // Returns a promise for the classname that is related to the given
  // classname through the key.
  // TODO: make this not in the DatabaseController interface


  redirectClassNameForKey(className, key) {
    return this.loadSchema().then(schema => {
      var t = schema.getExpectedType(className, key);

      if (t != null && typeof t !== 'string' && t.type === 'Relation') {
        return t.targetClass;
      }

      return className;
    });
  } // Uses the schema to validate the object (REST API format).
  // Returns a promise that resolves to the new schema.
  // This does not update this.schema, because in a situation like a
  // batch request, that could confuse other users of the schema.


  validateObject(className, object, query, {
    acl
  }) {
    let schema;
    const isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchema().then(s => {
      schema = s;

      if (isMaster) {
        return Promise.resolve();
      }

      return this.canAddField(schema, className, object, aclGroup);
    }).then(() => {
      return schema.validateObject(className, object, query);
    });
  }

  update(className, query, update, {
    acl,
    many,
    upsert
  } = {}, skipSanitization = false, validateOnly = false, validSchemaController) {
    const originalQuery = query;
    const originalUpdate = update; // Make a copy of the object, so we don't mutate the incoming data.

    update = (0, _deepcopy.default)(update);
    var relationUpdates = [];
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'update')).then(() => {
        relationUpdates = this.collectRelationUpdates(className, originalQuery.objectId, update);

        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'update', query, aclGroup);
        }

        if (!query) {
          return Promise.resolve();
        }

        if (acl) {
          query = addWriteACL(query, acl);
        }

        validateQuery(query, this.skipMongoDBServer13732Workaround);
        return schemaController.getOneSchema(className, true).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }

          throw error;
        }).then(schema => {
          Object.keys(update).forEach(fieldName => {
            if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }

            const rootFieldName = getRootFieldName(fieldName);

            if (!SchemaController.fieldNameIsValid(rootFieldName) && !isSpecialUpdateKey(rootFieldName)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }
          });

          for (const updateOperation in update) {
            if (update[updateOperation] && typeof update[updateOperation] === 'object' && Object.keys(update[updateOperation]).some(innerKey => innerKey.includes('$') || innerKey.includes('.'))) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
            }
          }

          update = transformObjectACL(update);
          transformAuthData(className, update, schema);

          if (validateOnly) {
            return this.adapter.find(className, schema, query, {}).then(result => {
              if (!result || !result.length) {
                throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
              }

              return {};
            });
          }

          if (many) {
            return this.adapter.updateObjectsByQuery(className, schema, query, update, this._transactionalSession);
          } else if (upsert) {
            return this.adapter.upsertOneObject(className, schema, query, update, this._transactionalSession);
          } else {
            return this.adapter.findOneAndUpdate(className, schema, query, update, this._transactionalSession);
          }
        });
      }).then(result => {
        if (!result) {
          throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
        }

        if (validateOnly) {
          return result;
        }

        return this.handleRelationUpdates(className, originalQuery.objectId, update, relationUpdates).then(() => {
          return result;
        });
      }).then(result => {
        if (skipSanitization) {
          return Promise.resolve(result);
        }

        return sanitizeDatabaseResult(originalUpdate, result);
      });
    });
  } // Collect all relation-updating operations from a REST-format update.
  // Returns a list of all relation updates to perform
  // This mutates update.


  collectRelationUpdates(className, objectId, update) {
    var ops = [];
    var deleteMe = [];
    objectId = update.objectId || objectId;

    var process = (op, key) => {
      if (!op) {
        return;
      }

      if (op.__op == 'AddRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }

      if (op.__op == 'RemoveRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }

      if (op.__op == 'Batch') {
        for (var x of op.ops) {
          process(x, key);
        }
      }
    };

    for (const key in update) {
      process(update[key], key);
    }

    for (const key of deleteMe) {
      delete update[key];
    }

    return ops;
  } // Processes relation-updating operations from a REST-format update.
  // Returns a promise that resolves when all updates have been performed


  handleRelationUpdates(className, objectId, update, ops) {
    var pending = [];
    objectId = update.objectId || objectId;
    ops.forEach(({
      key,
      op
    }) => {
      if (!op) {
        return;
      }

      if (op.__op == 'AddRelation') {
        for (const object of op.objects) {
          pending.push(this.addRelation(key, className, objectId, object.objectId));
        }
      }

      if (op.__op == 'RemoveRelation') {
        for (const object of op.objects) {
          pending.push(this.removeRelation(key, className, objectId, object.objectId));
        }
      }
    });
    return Promise.all(pending);
  } // Adds a relation.
  // Returns a promise that resolves successfully iff the add was successful.


  addRelation(key, fromClassName, fromId, toId) {
    const doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.upsertOneObject(`_Join:${key}:${fromClassName}`, relationSchema, doc, doc, this._transactionalSession);
  } // Removes a relation.
  // Returns a promise that resolves successfully iff the remove was
  // successful.


  removeRelation(key, fromClassName, fromId, toId) {
    var doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.deleteObjectsByQuery(`_Join:${key}:${fromClassName}`, relationSchema, doc, this._transactionalSession).catch(error => {
      // We don't care if they try to delete a non-existent relation.
      if (error.code == _node.Parse.Error.OBJECT_NOT_FOUND) {
        return;
      }

      throw error;
    });
  } // Removes objects matches this query from the database.
  // Returns a promise that resolves successfully iff the object was
  // deleted.
  // Options:
  //   acl:  a list of strings. If the object to be updated has an ACL,
  //         one of the provided strings must provide the caller with
  //         write permissions.


  destroy(className, query, {
    acl
  } = {}, validSchemaController) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'delete')).then(() => {
        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'delete', query, aclGroup);

          if (!query) {
            throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
          }
        } // delete by query


        if (acl) {
          query = addWriteACL(query, acl);
        }

        validateQuery(query, this.skipMongoDBServer13732Workaround);
        return schemaController.getOneSchema(className).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }

          throw error;
        }).then(parseFormatSchema => this.adapter.deleteObjectsByQuery(className, parseFormatSchema, query, this._transactionalSession)).catch(error => {
          // When deleting sessions while changing passwords, don't throw an error if they don't have any sessions.
          if (className === '_Session' && error.code === _node.Parse.Error.OBJECT_NOT_FOUND) {
            return Promise.resolve({});
          }

          throw error;
        });
      });
    });
  } // Inserts an object into the database.
  // Returns a promise that resolves successfully iff the object saved.


  create(className, object, {
    acl
  } = {}, validateOnly = false, validSchemaController) {
    // Make a copy of the object, so we don't mutate the incoming data.
    const originalObject = object;
    object = transformObjectACL(object);
    object.createdAt = {
      iso: object.createdAt,
      __type: 'Date'
    };
    object.updatedAt = {
      iso: object.updatedAt,
      __type: 'Date'
    };
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    const relationUpdates = this.collectRelationUpdates(className, null, object);
    return this.validateClassName(className).then(() => this.loadSchemaIfNeeded(validSchemaController)).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'create')).then(() => schemaController.enforceClassExists(className)).then(() => schemaController.getOneSchema(className, true)).then(schema => {
        transformAuthData(className, object, schema);
        flattenUpdateOperatorsForCreate(object);

        if (validateOnly) {
          return {};
        }

        return this.adapter.createObject(className, SchemaController.convertSchemaToAdapterSchema(schema), object, this._transactionalSession);
      }).then(result => {
        if (validateOnly) {
          return originalObject;
        }

        return this.handleRelationUpdates(className, object.objectId, object, relationUpdates).then(() => {
          return sanitizeDatabaseResult(originalObject, result.ops[0]);
        });
      });
    });
  }

  canAddField(schema, className, object, aclGroup) {
    const classSchema = schema.schemaData[className];

    if (!classSchema) {
      return Promise.resolve();
    }

    const fields = Object.keys(object);
    const schemaFields = Object.keys(classSchema.fields);
    const newKeys = fields.filter(field => {
      // Skip fields that are unset
      if (object[field] && object[field].__op && object[field].__op === 'Delete') {
        return false;
      }

      return schemaFields.indexOf(field) < 0;
    });

    if (newKeys.length > 0) {
      return schema.validatePermission(className, aclGroup, 'addField');
    }

    return Promise.resolve();
  } // Won't delete collections in the system namespace

  /**
   * Delete all classes and clears the schema cache
   *
   * @param {boolean} fast set to true if it's ok to just delete rows and not indexes
   * @returns {Promise<void>} when the deletions completes
   */


  deleteEverything(fast = false) {
    this.schemaPromise = null;
    return Promise.all([this.adapter.deleteAllClasses(fast), this.schemaCache.clear()]);
  } // Returns a promise for a list of related ids given an owning id.
  // className here is the owning className.


  relatedIds(className, key, owningId, queryOptions) {
    const {
      skip,
      limit,
      sort
    } = queryOptions;
    const findOptions = {};

    if (sort && sort.createdAt && this.adapter.canSortOnJoinTables) {
      findOptions.sort = {
        _id: sort.createdAt
      };
      findOptions.limit = limit;
      findOptions.skip = skip;
      queryOptions.skip = 0;
    }

    return this.adapter.find(joinTableName(className, key), relationSchema, {
      owningId
    }, findOptions).then(results => results.map(result => result.relatedId));
  } // Returns a promise for a list of owning ids given some related ids.
  // className here is the owning className.


  owningIds(className, key, relatedIds) {
    return this.adapter.find(joinTableName(className, key), relationSchema, {
      relatedId: {
        $in: relatedIds
      }
    }, {}).then(results => results.map(result => result.owningId));
  } // Modifies query so that it no longer has $in on relation fields, or
  // equal-to-pointer constraints on relation fields.
  // Returns a promise that resolves when query is mutated


  reduceInRelation(className, query, schema) {
    // Search for an in-relation or equal-to-relation
    // Make it sequential for now, not sure of paralleization side effects
    if (query['$or']) {
      const ors = query['$or'];
      return Promise.all(ors.map((aQuery, index) => {
        return this.reduceInRelation(className, aQuery, schema).then(aQuery => {
          query['$or'][index] = aQuery;
        });
      })).then(() => {
        return Promise.resolve(query);
      });
    }

    const promises = Object.keys(query).map(key => {
      const t = schema.getExpectedType(className, key);

      if (!t || t.type !== 'Relation') {
        return Promise.resolve(query);
      }

      let queries = null;

      if (query[key] && (query[key]['$in'] || query[key]['$ne'] || query[key]['$nin'] || query[key].__type == 'Pointer')) {
        // Build the list of queries
        queries = Object.keys(query[key]).map(constraintKey => {
          let relatedIds;
          let isNegation = false;

          if (constraintKey === 'objectId') {
            relatedIds = [query[key].objectId];
          } else if (constraintKey == '$in') {
            relatedIds = query[key]['$in'].map(r => r.objectId);
          } else if (constraintKey == '$nin') {
            isNegation = true;
            relatedIds = query[key]['$nin'].map(r => r.objectId);
          } else if (constraintKey == '$ne') {
            isNegation = true;
            relatedIds = [query[key]['$ne'].objectId];
          } else {
            return;
          }

          return {
            isNegation,
            relatedIds
          };
        });
      } else {
        queries = [{
          isNegation: false,
          relatedIds: []
        }];
      } // remove the current queryKey as we don,t need it anymore


      delete query[key]; // execute each query independently to build the list of
      // $in / $nin

      const promises = queries.map(q => {
        if (!q) {
          return Promise.resolve();
        }

        return this.owningIds(className, key, q.relatedIds).then(ids => {
          if (q.isNegation) {
            this.addNotInObjectIdsIds(ids, query);
          } else {
            this.addInObjectIdsIds(ids, query);
          }

          return Promise.resolve();
        });
      });
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      });
    });
    return Promise.all(promises).then(() => {
      return Promise.resolve(query);
    });
  } // Modifies query so that it no longer has $relatedTo
  // Returns a promise that resolves when query is mutated


  reduceRelationKeys(className, query, queryOptions) {
    if (query['$or']) {
      return Promise.all(query['$or'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions);
      }));
    }

    var relatedTo = query['$relatedTo'];

    if (relatedTo) {
      return this.relatedIds(relatedTo.object.className, relatedTo.key, relatedTo.object.objectId, queryOptions).then(ids => {
        delete query['$relatedTo'];
        this.addInObjectIdsIds(ids, query);
        return this.reduceRelationKeys(className, query, queryOptions);
      }).then(() => {});
    }
  }

  addInObjectIdsIds(ids = null, query) {
    const idsFromString = typeof query.objectId === 'string' ? [query.objectId] : null;
    const idsFromEq = query.objectId && query.objectId['$eq'] ? [query.objectId['$eq']] : null;
    const idsFromIn = query.objectId && query.objectId['$in'] ? query.objectId['$in'] : null; // -disable-next

    const allIds = [idsFromString, idsFromEq, idsFromIn, ids].filter(list => list !== null);
    const totalLength = allIds.reduce((memo, list) => memo + list.length, 0);
    let idsIntersection = [];

    if (totalLength > 125) {
      idsIntersection = _intersect.default.big(allIds);
    } else {
      idsIntersection = (0, _intersect.default)(allIds);
    } // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.


    if (!('objectId' in query)) {
      query.objectId = {
        $in: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $in: undefined,
        $eq: query.objectId
      };
    }

    query.objectId['$in'] = idsIntersection;
    return query;
  }

  addNotInObjectIdsIds(ids = [], query) {
    const idsFromNin = query.objectId && query.objectId['$nin'] ? query.objectId['$nin'] : [];
    let allIds = [...idsFromNin, ...ids].filter(list => list !== null); // make a set and spread to remove duplicates

    allIds = [...new Set(allIds)]; // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.

    if (!('objectId' in query)) {
      query.objectId = {
        $nin: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $nin: undefined,
        $eq: query.objectId
      };
    }

    query.objectId['$nin'] = allIds;
    return query;
  } // Runs a query on the database.
  // Returns a promise that resolves to a list of items.
  // Options:
  //   skip    number of results to skip.
  //   limit   limit to this number of results.
  //   sort    an object where keys are the fields to sort by.
  //           the value is +1 for ascending, -1 for descending.
  //   count   run a count instead of returning results.
  //   acl     restrict this operation with an ACL for the provided array
  //           of user objectIds and roles. acl: null means no user.
  //           when this field is not present, don't do anything regarding ACLs.
  // TODO: make userIds not needed here. The db adapter shouldn't know
  // anything about users, ideally. Then, improve the format of the ACL
  // arg to work like the others.


  find(className, query, {
    skip,
    limit,
    acl,
    sort = {},
    count,
    keys,
    op,
    distinct,
    pipeline,
    readPreference
  } = {}, auth = {}, validSchemaController) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    op = op || (typeof query.objectId == 'string' && Object.keys(query).length === 1 ? 'get' : 'find'); // Count operation if counting

    op = count === true ? 'count' : op;
    let classExists = true;
    return tracePromise('loadSchema', className, this.loadSchemaIfNeeded(validSchemaController)).then(schemaController => {
      //Allow volatile classes if querying with Master (for _PushStatus)
      //TODO: Move volatile classes concept into mongo adapter, postgres adapter shouldn't care
      //that api.parse.com breaks when _PushStatus exists in mongo.
      return tracePromise('getOneSchema', className, schemaController.getOneSchema(className, isMaster)).catch(error => {
        // Behavior for non-existent classes is kinda weird on Parse.com. Probably doesn't matter too much.
        // For now, pretend the class exists but has no objects,
        if (error === undefined) {
          classExists = false;
          return {
            fields: {}
          };
        }

        throw error;
      }).then(schema => {
        // Parse.com treats queries on _created_at and _updated_at as if they were queries on createdAt and updatedAt,
        // so duplicate that behavior here. If both are specified, the correct behavior to match Parse.com is to
        // use the one that appears first in the sort list.
        if (sort._created_at) {
          sort.createdAt = sort._created_at;
          delete sort._created_at;
        }

        if (sort._updated_at) {
          sort.updatedAt = sort._updated_at;
          delete sort._updated_at;
        }

        const queryOptions = {
          skip,
          limit,
          sort,
          keys,
          readPreference
        };
        Object.keys(sort).forEach(fieldName => {
          if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Cannot sort by ${fieldName}`);
          }

          const rootFieldName = getRootFieldName(fieldName);

          if (!SchemaController.fieldNameIsValid(rootFieldName)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}.`);
          }
        });
        return (isMaster ? Promise.resolve() : tracePromise('validatePermission', className, schemaController.validatePermission(className, aclGroup, op))).then(() => tracePromise('reduceRelationKeys', className, this.reduceRelationKeys(className, query, queryOptions))).then(() => tracePromise('reduceInRelation', className, this.reduceInRelation(className, query, schemaController))).then(() => {
          let protectedFields;

          if (!isMaster) {
            query = this.addPointerPermissions(schemaController, className, op, query, aclGroup);
            /* Don't use projections to optimize the protectedFields since the protectedFields
              based on pointer-permissions are determined after querying. The filtering can
              overwrite the protected fields. */

            protectedFields = this.addProtectedFields(schemaController, className, query, aclGroup, auth);
          }

          if (!query) {
            if (op === 'get') {
              throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
            } else {
              return [];
            }
          }

          if (!isMaster) {
            if (op === 'update' || op === 'delete') {
              query = addWriteACL(query, aclGroup);
            } else {
              query = addReadACL(query, aclGroup);
            }
          }

          validateQuery(query, this.skipMongoDBServer13732Workaround);

          if (count) {
            if (!classExists) {
              return 0;
            } else {
              return this.adapter.count(className, schema, query, readPreference);
            }
          } else if (distinct) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.distinct(className, schema, query, distinct);
            }
          } else if (pipeline) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.aggregate(className, schema, pipeline, readPreference);
            }
          } else {
            return this.adapter.find(className, schema, query, queryOptions).then(objects => objects.map(object => {
              object = untransformObjectACL(object);
              return filterSensitiveData(isMaster, aclGroup, auth, op, schemaController, className, protectedFields, object);
            })).catch(error => {
              throw new _node.Parse.Error(_node.Parse.Error.INTERNAL_SERVER_ERROR, error);
            });
          }
        });
      });
    });
  }

  deleteSchema(className) {
    return this.loadSchema({
      clearCache: true
    }).then(schemaController => schemaController.getOneSchema(className, true)).catch(error => {
      if (error === undefined) {
        return {
          fields: {}
        };
      } else {
        throw error;
      }
    }).then(schema => {
      return this.collectionExists(className).then(() => this.adapter.count(className, {
        fields: {}
      }, null, '', false)).then(count => {
        if (count > 0) {
          throw new _node.Parse.Error(255, `Class ${className} is not empty, contains ${count} objects, cannot drop schema.`);
        }

        return this.adapter.deleteClass(className);
      }).then(wasParseCollection => {
        if (wasParseCollection) {
          const relationFieldNames = Object.keys(schema.fields).filter(fieldName => schema.fields[fieldName].type === 'Relation');
          return Promise.all(relationFieldNames.map(name => this.adapter.deleteClass(joinTableName(className, name)))).then(() => {
            return;
          });
        } else {
          return Promise.resolve();
        }
      });
    });
  }

  addPointerPermissions(schema, className, operation, query, aclGroup = []) {
    // Check if class has public permission for operation
    // If the BaseCLP pass, let go through
    if (schema.testPermissionsForClassName(className, aclGroup, operation)) {
      return query;
    }

    const perms = schema.getClassLevelPermissions(className);
    const field = ['get', 'find'].indexOf(operation) > -1 ? 'readUserFields' : 'writeUserFields';
    const userACL = aclGroup.filter(acl => {
      return acl.indexOf('role:') != 0 && acl != '*';
    }); // the ACL should have exactly 1 user

    if (perms && perms[field] && perms[field].length > 0) {
      // No user set return undefined
      // If the length is > 1, that means we didn't de-dupe users correctly
      if (userACL.length != 1) {
        return;
      }

      const userId = userACL[0];
      const userPointer = {
        __type: 'Pointer',
        className: '_User',
        objectId: userId
      };
      const permFields = perms[field];
      const ors = permFields.flatMap(key => {
        // constraint for single pointer setup
        const q = {
          [key]: userPointer
        }; // constraint for users-array setup

        const qa = {
          [key]: {
            $all: [userPointer]
          }
        }; // if we already have a constraint on the key, use the $and

        if (Object.prototype.hasOwnProperty.call(query, key)) {
          return [{
            $and: [q, query]
          }, {
            $and: [qa, query]
          }];
        } // otherwise just add the constaint


        return [Object.assign({}, query, q), Object.assign({}, query, qa)];
      });
      return {
        $or: ors
      };
    } else {
      return query;
    }
  }

  addProtectedFields(schema, className, query = {}, aclGroup = [], auth = {}) {
    const perms = schema.getClassLevelPermissions(className);
    if (!perms) return null;
    const protectedFields = perms.protectedFields;
    if (!protectedFields) return null;
    if (aclGroup.indexOf(query.objectId) > -1) return null; // remove userField keys since they are filtered after querying

    let protectedKeys = Object.keys(protectedFields).reduce((acc, val) => {
      if (val.startsWith('userField:')) return acc;
      return acc.concat(protectedFields[val]);
    }, []);
    [...(auth.userRoles || [])].forEach(role => {
      const fields = protectedFields[role];

      if (fields) {
        protectedKeys = protectedKeys.filter(v => fields.includes(v));
      }
    });
    return protectedKeys;
  }

  createTransactionalSession() {
    return this.adapter.createTransactionalSession().then(transactionalSession => {
      this._transactionalSession = transactionalSession;
    });
  }

  commitTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to commit');
    }

    return this.adapter.commitTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  }

  abortTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to abort');
    }

    return this.adapter.abortTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  } // TODO: create indexes on first creation of a _User object. Otherwise it's impossible to
  // have a Parse app without it having a _User collection.


  performInitialization() {
    const requiredUserFields = {
      fields: _objectSpread({}, SchemaController.defaultColumns._Default, {}, SchemaController.defaultColumns._User)
    };
    const requiredRoleFields = {
      fields: _objectSpread({}, SchemaController.defaultColumns._Default, {}, SchemaController.defaultColumns._Role)
    };
    const userClassPromise = this.loadSchema().then(schema => schema.enforceClassExists('_User'));
    const roleClassPromise = this.loadSchema().then(schema => schema.enforceClassExists('_Role'));
    const usernameUniqueness = userClassPromise.then(() => this.adapter.ensureUniqueness('_User', requiredUserFields, ['username'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for usernames: ', error);

      throw error;
    });
    const emailUniqueness = userClassPromise.then(() => this.adapter.ensureUniqueness('_User', requiredUserFields, ['email'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for user email addresses: ', error);

      throw error;
    });
    const roleUniqueness = roleClassPromise.then(() => this.adapter.ensureUniqueness('_Role', requiredRoleFields, ['name'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for role name: ', error);

      throw error;
    });
    const indexPromise = this.adapter.updateSchemaWithIndexes(); // Create tables for volatile classes

    const adapterInit = this.adapter.performInitialization({
      VolatileClassesSchemas: SchemaController.VolatileClassesSchemas
    });
    return Promise.all([usernameUniqueness, emailUniqueness, roleUniqueness, adapterInit, indexPromise]);
  }

}

function tracePromise(operation, className, promise = Promise.resolve()) {
  const parent = _awsXraySdk.default.getSegment();

  if (!parent) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    _awsXraySdk.default.captureAsyncFunc(`Parse-Server_DatabaseCtrl_${operation}_${className}`, subsegment => {
      subsegment && subsegment.addAnnotation('Controller', 'DatabaseCtrl');
      subsegment && subsegment.addAnnotation('Operation', operation);
      className & subsegment && subsegment.addAnnotation('ClassName', className);
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

module.exports = DatabaseController; // Expose validateQuery for tests

module.exports._validateQuery = validateQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Db250cm9sbGVycy9EYXRhYmFzZUNvbnRyb2xsZXIuanMiXSwibmFtZXMiOlsiYWRkV3JpdGVBQ0wiLCJxdWVyeSIsImFjbCIsIm5ld1F1ZXJ5IiwiXyIsImNsb25lRGVlcCIsIl93cGVybSIsIiRpbiIsImFkZFJlYWRBQ0wiLCJfcnBlcm0iLCJ0cmFuc2Zvcm1PYmplY3RBQ0wiLCJBQ0wiLCJyZXN1bHQiLCJlbnRyeSIsInJlYWQiLCJwdXNoIiwid3JpdGUiLCJzcGVjaWFsUXVlcnlrZXlzIiwiaXNTcGVjaWFsUXVlcnlLZXkiLCJrZXkiLCJpbmRleE9mIiwidmFsaWRhdGVRdWVyeSIsInNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kIiwiUGFyc2UiLCJFcnJvciIsIklOVkFMSURfUVVFUlkiLCIkb3IiLCJBcnJheSIsImZvckVhY2giLCJlbCIsIk9iamVjdCIsImtleXMiLCJub0NvbGxpc2lvbnMiLCJzb21lIiwic3VicSIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImhhc05lYXJzIiwic3VicXVlcnkiLCIkYW5kIiwiJG5vciIsImxlbmd0aCIsIiRyZWdleCIsIiRvcHRpb25zIiwibWF0Y2giLCJJTlZBTElEX0tFWV9OQU1FIiwiZmlsdGVyU2Vuc2l0aXZlRGF0YSIsImlzTWFzdGVyIiwiYWNsR3JvdXAiLCJhdXRoIiwib3BlcmF0aW9uIiwic2NoZW1hIiwiY2xhc3NOYW1lIiwicHJvdGVjdGVkRmllbGRzIiwib2JqZWN0IiwidXNlcklkIiwidXNlciIsImlkIiwicGVybXMiLCJnZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJpc1JlYWRPcGVyYXRpb24iLCJwcm90ZWN0ZWRGaWVsZHNQb2ludGVyUGVybSIsImZpbHRlciIsInN0YXJ0c1dpdGgiLCJtYXAiLCJzdWJzdHJpbmciLCJ2YWx1ZSIsIm5ld1Byb3RlY3RlZEZpZWxkcyIsIm92ZXJyaWRlUHJvdGVjdGVkRmllbGRzIiwicG9pbnRlclBlcm0iLCJwb2ludGVyUGVybUluY2x1ZGVzVXNlciIsInJlYWRVc2VyRmllbGRWYWx1ZSIsImlzQXJyYXkiLCJvYmplY3RJZCIsImlzVXNlckNsYXNzIiwiayIsInBhc3N3b3JkIiwiX2hhc2hlZF9wYXNzd29yZCIsInNlc3Npb25Ub2tlbiIsIl9lbWFpbF92ZXJpZnlfdG9rZW4iLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJfdG9tYnN0b25lIiwiX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0IiwiX2ZhaWxlZF9sb2dpbl9jb3VudCIsIl9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJhdXRoRGF0YSIsInNwZWNpYWxLZXlzRm9yVXBkYXRlIiwiaXNTcGVjaWFsVXBkYXRlS2V5IiwiZXhwYW5kUmVzdWx0T25LZXlQYXRoIiwicGF0aCIsInNwbGl0IiwiZmlyc3RLZXkiLCJuZXh0UGF0aCIsInNsaWNlIiwiam9pbiIsInNhbml0aXplRGF0YWJhc2VSZXN1bHQiLCJvcmlnaW5hbE9iamVjdCIsInJlc3BvbnNlIiwiUHJvbWlzZSIsInJlc29sdmUiLCJrZXlVcGRhdGUiLCJfX29wIiwiam9pblRhYmxlTmFtZSIsImZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUiLCJhbW91bnQiLCJJTlZBTElEX0pTT04iLCJvYmplY3RzIiwiQ09NTUFORF9VTkFWQUlMQUJMRSIsInRyYW5zZm9ybUF1dGhEYXRhIiwicHJvdmlkZXIiLCJwcm92aWRlckRhdGEiLCJmaWVsZE5hbWUiLCJmaWVsZHMiLCJ0eXBlIiwidW50cmFuc2Zvcm1PYmplY3RBQ0wiLCJvdXRwdXQiLCJnZXRSb290RmllbGROYW1lIiwicmVsYXRpb25TY2hlbWEiLCJyZWxhdGVkSWQiLCJvd25pbmdJZCIsIkRhdGFiYXNlQ29udHJvbGxlciIsImNvbnN0cnVjdG9yIiwiYWRhcHRlciIsInNjaGVtYUNhY2hlIiwic2NoZW1hUHJvbWlzZSIsIl90cmFuc2FjdGlvbmFsU2Vzc2lvbiIsImNvbGxlY3Rpb25FeGlzdHMiLCJjbGFzc0V4aXN0cyIsInB1cmdlQ29sbGVjdGlvbiIsImxvYWRTY2hlbWEiLCJ0aGVuIiwic2NoZW1hQ29udHJvbGxlciIsImdldE9uZVNjaGVtYSIsImRlbGV0ZU9iamVjdHNCeVF1ZXJ5IiwidmFsaWRhdGVDbGFzc05hbWUiLCJTY2hlbWFDb250cm9sbGVyIiwiY2xhc3NOYW1lSXNWYWxpZCIsInJlamVjdCIsIklOVkFMSURfQ0xBU1NfTkFNRSIsIm9wdGlvbnMiLCJjbGVhckNhY2hlIiwibG9hZCIsImxvYWRTY2hlbWFJZk5lZWRlZCIsInJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IiwidCIsImdldEV4cGVjdGVkVHlwZSIsInRhcmdldENsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJ1bmRlZmluZWQiLCJzIiwiY2FuQWRkRmllbGQiLCJ1cGRhdGUiLCJtYW55IiwidXBzZXJ0Iiwic2tpcFNhbml0aXphdGlvbiIsInZhbGlkYXRlT25seSIsInZhbGlkU2NoZW1hQ29udHJvbGxlciIsIm9yaWdpbmFsUXVlcnkiLCJvcmlnaW5hbFVwZGF0ZSIsInJlbGF0aW9uVXBkYXRlcyIsInZhbGlkYXRlUGVybWlzc2lvbiIsImNvbGxlY3RSZWxhdGlvblVwZGF0ZXMiLCJhZGRQb2ludGVyUGVybWlzc2lvbnMiLCJjYXRjaCIsImVycm9yIiwicm9vdEZpZWxkTmFtZSIsImZpZWxkTmFtZUlzVmFsaWQiLCJ1cGRhdGVPcGVyYXRpb24iLCJpbm5lcktleSIsImluY2x1ZGVzIiwiSU5WQUxJRF9ORVNURURfS0VZIiwiZmluZCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJ1cGRhdGVPYmplY3RzQnlRdWVyeSIsInVwc2VydE9uZU9iamVjdCIsImZpbmRPbmVBbmRVcGRhdGUiLCJoYW5kbGVSZWxhdGlvblVwZGF0ZXMiLCJvcHMiLCJkZWxldGVNZSIsInByb2Nlc3MiLCJvcCIsIngiLCJwZW5kaW5nIiwiYWRkUmVsYXRpb24iLCJyZW1vdmVSZWxhdGlvbiIsImFsbCIsImZyb21DbGFzc05hbWUiLCJmcm9tSWQiLCJ0b0lkIiwiZG9jIiwiY29kZSIsImRlc3Ryb3kiLCJwYXJzZUZvcm1hdFNjaGVtYSIsImNyZWF0ZSIsImNyZWF0ZWRBdCIsImlzbyIsIl9fdHlwZSIsInVwZGF0ZWRBdCIsImVuZm9yY2VDbGFzc0V4aXN0cyIsImNyZWF0ZU9iamVjdCIsImNvbnZlcnRTY2hlbWFUb0FkYXB0ZXJTY2hlbWEiLCJjbGFzc1NjaGVtYSIsInNjaGVtYURhdGEiLCJzY2hlbWFGaWVsZHMiLCJuZXdLZXlzIiwiZmllbGQiLCJkZWxldGVFdmVyeXRoaW5nIiwiZmFzdCIsImRlbGV0ZUFsbENsYXNzZXMiLCJjbGVhciIsInJlbGF0ZWRJZHMiLCJxdWVyeU9wdGlvbnMiLCJza2lwIiwibGltaXQiLCJzb3J0IiwiZmluZE9wdGlvbnMiLCJjYW5Tb3J0T25Kb2luVGFibGVzIiwiX2lkIiwicmVzdWx0cyIsIm93bmluZ0lkcyIsInJlZHVjZUluUmVsYXRpb24iLCJvcnMiLCJhUXVlcnkiLCJpbmRleCIsInByb21pc2VzIiwicXVlcmllcyIsImNvbnN0cmFpbnRLZXkiLCJpc05lZ2F0aW9uIiwiciIsInEiLCJpZHMiLCJhZGROb3RJbk9iamVjdElkc0lkcyIsImFkZEluT2JqZWN0SWRzSWRzIiwicmVkdWNlUmVsYXRpb25LZXlzIiwicmVsYXRlZFRvIiwiaWRzRnJvbVN0cmluZyIsImlkc0Zyb21FcSIsImlkc0Zyb21JbiIsImFsbElkcyIsImxpc3QiLCJ0b3RhbExlbmd0aCIsInJlZHVjZSIsIm1lbW8iLCJpZHNJbnRlcnNlY3Rpb24iLCJpbnRlcnNlY3QiLCJiaWciLCIkZXEiLCJpZHNGcm9tTmluIiwiU2V0IiwiJG5pbiIsImNvdW50IiwiZGlzdGluY3QiLCJwaXBlbGluZSIsInJlYWRQcmVmZXJlbmNlIiwidHJhY2VQcm9taXNlIiwiX2NyZWF0ZWRfYXQiLCJfdXBkYXRlZF9hdCIsImFkZFByb3RlY3RlZEZpZWxkcyIsImFnZ3JlZ2F0ZSIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsImRlbGV0ZVNjaGVtYSIsImRlbGV0ZUNsYXNzIiwid2FzUGFyc2VDb2xsZWN0aW9uIiwicmVsYXRpb25GaWVsZE5hbWVzIiwibmFtZSIsInRlc3RQZXJtaXNzaW9uc0ZvckNsYXNzTmFtZSIsInVzZXJBQ0wiLCJ1c2VyUG9pbnRlciIsInBlcm1GaWVsZHMiLCJmbGF0TWFwIiwicWEiLCIkYWxsIiwiYXNzaWduIiwicHJvdGVjdGVkS2V5cyIsImFjYyIsInZhbCIsImNvbmNhdCIsInVzZXJSb2xlcyIsInJvbGUiLCJ2IiwiY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24iLCJ0cmFuc2FjdGlvbmFsU2Vzc2lvbiIsImNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsInBlcmZvcm1Jbml0aWFsaXphdGlvbiIsInJlcXVpcmVkVXNlckZpZWxkcyIsImRlZmF1bHRDb2x1bW5zIiwiX0RlZmF1bHQiLCJfVXNlciIsInJlcXVpcmVkUm9sZUZpZWxkcyIsIl9Sb2xlIiwidXNlckNsYXNzUHJvbWlzZSIsInJvbGVDbGFzc1Byb21pc2UiLCJ1c2VybmFtZVVuaXF1ZW5lc3MiLCJlbnN1cmVVbmlxdWVuZXNzIiwibG9nZ2VyIiwid2FybiIsImVtYWlsVW5pcXVlbmVzcyIsInJvbGVVbmlxdWVuZXNzIiwiaW5kZXhQcm9taXNlIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJhZGFwdGVySW5pdCIsIlZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMiLCJwcm9taXNlIiwicGFyZW50IiwiQVdTWFJheSIsImdldFNlZ21lbnQiLCJjYXB0dXJlQXN5bmNGdW5jIiwic3Vic2VnbWVudCIsImFkZEFubm90YXRpb24iLCJjbG9zZSIsIm1vZHVsZSIsImV4cG9ydHMiLCJfdmFsaWRhdGVRdWVyeSJdLCJtYXBwaW5ncyI6Ijs7QUFLQTs7QUFFQTs7QUFFQTs7QUFFQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFNQTs7Ozs7Ozs7Ozs7Ozs7Ozs7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SUFBSTdNLE9BQUosQ0FBWSxDQUFDQyxPQUFELEVBQVVzQyxNQUFWLEtBQXFCO0FBQ3RDd0ssd0JBQVFFLGdCQUFSLENBQ0csNkJBQTRCcFEsU0FBVSxJQUFHRSxTQUFVLEVBRHRELEVBRUVtUSxVQUFVLElBQUk7QUFDWkEsTUFBQUEsVUFBVSxJQUFJQSxVQUFVLENBQUNDLGFBQVgsQ0FBeUIsWUFBekIsRUFBdUMsY0FBdkMsQ0FBZDtBQUNBRCxNQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0MsYUFBWCxDQUF5QixXQUF6QixFQUFzQ3RRLFNBQXRDLENBQWQ7QUFDQUUsTUFBQUEsU0FBUyxHQUFHbVEsVUFBWixJQUNFQSxVQUFVLENBQUNDLGFBQVgsQ0FBeUIsV0FBekIsRUFBc0NwUSxTQUF0QyxDQURGO0FBRUE4UCxNQUFBQSxPQUFPLENBQUM3SyxJQUFSLENBQ0UsVUFBUzFILE1BQVQsRUFBaUI7QUFDZjJGLFFBQUFBLE9BQU8sQ0FBQzNGLE1BQUQsQ0FBUDtBQUNBNFMsUUFBQUEsVUFBVSxJQUFJQSxVQUFVLENBQUNFLEtBQVgsRUFBZDtBQUNELE9BSkgsRUFLRSxVQUFTbEosS0FBVCxFQUFnQjtBQUNkM0IsUUFBQUEsTUFBTSxDQUFDMkIsS0FBRCxDQUFOO0FBQ0FnSixRQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0UsS0FBWCxDQUFpQmxKLEtBQWpCLENBQWQ7QUFDRCxPQVJIO0FBVUQsS0FqQkg7QUFtQkQsR0FwQk0sQ0FBUDtBQXFCRDs7QUFFRG1KLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQmhNLGtCQUFqQixDLENBQ0E7O0FBQ0ErTCxNQUFNLENBQUNDLE9BQVAsQ0FBZUMsY0FBZixHQUFnQ3hTLGFBQWhDIiwic291cmNlc0NvbnRlbnQiOlsi77u/Ly8gQGZsb3dcbi8vIEEgZGF0YWJhc2UgYWRhcHRlciB0aGF0IHdvcmtzIHdpdGggZGF0YSBleHBvcnRlZCBmcm9tIHRoZSBob3N0ZWRcbi8vIFBhcnNlIGRhdGFiYXNlLlxuXG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCB7IFBhcnNlIH0gZnJvbSAncGFyc2Uvbm9kZSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBpbnRlcnNlY3QgZnJvbSAnaW50ZXJzZWN0Jztcbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuaW1wb3J0IGRlZXBjb3B5IGZyb20gJ2RlZXBjb3B5JztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi4vbG9nZ2VyJztcbmltcG9ydCAqIGFzIFNjaGVtYUNvbnRyb2xsZXIgZnJvbSAnLi9TY2hlbWFDb250cm9sbGVyJztcbmltcG9ydCB7IFN0b3JhZ2VBZGFwdGVyIH0gZnJvbSAnLi4vQWRhcHRlcnMvU3RvcmFnZS9TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQgdHlwZSB7XG4gIFF1ZXJ5T3B0aW9ucyxcbiAgRnVsbFF1ZXJ5T3B0aW9ucyxcbn0gZnJvbSAnLi4vQWRhcHRlcnMvU3RvcmFnZS9TdG9yYWdlQWRhcHRlcic7XG5cbmltcG9ydCBBV1NYUmF5IGZyb20gJ2F3cy14cmF5LXNkayc7XG5cbmZ1bmN0aW9uIGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpIHtcbiAgY29uc3QgbmV3UXVlcnkgPSBfLmNsb25lRGVlcChxdWVyeSk7XG4gIC8vQ2FuJ3QgYmUgYW55IGV4aXN0aW5nICdfd3Blcm0nIHF1ZXJ5LCB3ZSBkb24ndCBhbGxvdyBjbGllbnQgcXVlcmllcyBvbiB0aGF0LCBubyBuZWVkIHRvICRhbmRcbiAgbmV3UXVlcnkuX3dwZXJtID0geyAkaW46IFtudWxsLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuZnVuY3Rpb24gYWRkUmVhZEFDTChxdWVyeSwgYWNsKSB7XG4gIGNvbnN0IG5ld1F1ZXJ5ID0gXy5jbG9uZURlZXAocXVlcnkpO1xuICAvL0Nhbid0IGJlIGFueSBleGlzdGluZyAnX3JwZXJtJyBxdWVyeSwgd2UgZG9uJ3QgYWxsb3cgY2xpZW50IHF1ZXJpZXMgb24gdGhhdCwgbm8gbmVlZCB0byAkYW5kXG4gIG5ld1F1ZXJ5Ll9ycGVybSA9IHsgJGluOiBbbnVsbCwgJyonLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuLy8gVHJhbnNmb3JtcyBhIFJFU1QgQVBJIGZvcm1hdHRlZCBBQ0wgb2JqZWN0IHRvIG91ciB0d28tZmllbGQgbW9uZ28gZm9ybWF0LlxuY29uc3QgdHJhbnNmb3JtT2JqZWN0QUNMID0gKHsgQUNMLCAuLi5yZXN1bHQgfSkgPT4ge1xuICBpZiAoIUFDTCkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICByZXN1bHQuX3dwZXJtID0gW107XG4gIHJlc3VsdC5fcnBlcm0gPSBbXTtcblxuICBmb3IgKGNvbnN0IGVudHJ5IGluIEFDTCkge1xuICAgIGlmIChBQ0xbZW50cnldLnJlYWQpIHtcbiAgICAgIHJlc3VsdC5fcnBlcm0ucHVzaChlbnRyeSk7XG4gICAgfVxuICAgIGlmIChBQ0xbZW50cnldLndyaXRlKSB7XG4gICAgICByZXN1bHQuX3dwZXJtLnB1c2goZW50cnkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufTtcblxuY29uc3Qgc3BlY2lhbFF1ZXJ5a2V5cyA9IFtcbiAgJyRhbmQnLFxuICAnJG9yJyxcbiAgJyRub3InLFxuICAnX3JwZXJtJyxcbiAgJ193cGVybScsXG4gICdfcGVyaXNoYWJsZV90b2tlbicsXG4gICdfZW1haWxfdmVyaWZ5X3Rva2VuJyxcbiAgJ19lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCcsXG4gICdfYWNjb3VudF9sb2Nrb3V0X2V4cGlyZXNfYXQnLFxuICAnX2ZhaWxlZF9sb2dpbl9jb3VudCcsXG5dO1xuXG5jb25zdCBpc1NwZWNpYWxRdWVyeUtleSA9IGtleSA9PiB7XG4gIHJldHVybiBzcGVjaWFsUXVlcnlrZXlzLmluZGV4T2Yoa2V5KSA+PSAwO1xufTtcblxuY29uc3QgdmFsaWRhdGVRdWVyeSA9IChcbiAgcXVlcnk6IGFueSxcbiAgc2tpcE1vbmdvREJTZXJ2ZXIxMzczMldvcmthcm91bmQ6IGJvb2xlYW5cbik6IHZvaWQgPT4ge1xuICBpZiAocXVlcnkuQUNMKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdDYW5ub3QgcXVlcnkgb24gQUNMLicpO1xuICB9XG5cbiAgaWYgKHF1ZXJ5LiRvcikge1xuICAgIGlmIChxdWVyeS4kb3IgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgcXVlcnkuJG9yLmZvckVhY2goZWwgPT5cbiAgICAgICAgdmFsaWRhdGVRdWVyeShlbCwgc2tpcE1vbmdvREJTZXJ2ZXIxMzczMldvcmthcm91bmQpXG4gICAgICApO1xuXG4gICAgICBpZiAoIXNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kKSB7XG4gICAgICAgIC8qIEluIE1vbmdvREIgMy4yICYgMy40LCAkb3IgcXVlcmllcyB3aGljaCBhcmUgbm90IGFsb25lIGF0IHRoZSB0b3BcbiAgICAgICAgICogbGV2ZWwgb2YgdGhlIHF1ZXJ5IGNhbiBub3QgbWFrZSBlZmZpY2llbnQgdXNlIG9mIGluZGV4ZXMgZHVlIHRvIGFcbiAgICAgICAgICogbG9uZyBzdGFuZGluZyBidWcga25vd24gYXMgU0VSVkVSLTEzNzMyLlxuICAgICAgICAgKlxuICAgICAgICAgKiBUaGlzIGJ1ZyB3YXMgZml4ZWQgaW4gTW9uZ29EQiB2ZXJzaW9uIDMuNi5cbiAgICAgICAgICpcbiAgICAgICAgICogRm9yIHZlcnNpb25zIHByZS0zLjYsIHRoZSBiZWxvdyBsb2dpYyBwcm9kdWNlcyBhIHN1YnN0YW50aWFsXG4gICAgICAgICAqIHBlcmZvcm1hbmNlIGltcHJvdmVtZW50IGluc2lkZSB0aGUgZGF0YWJhc2UgYnkgYXZvaWRpbmcgdGhlIGJ1Zy5cbiAgICAgICAgICpcbiAgICAgICAgICogRm9yIHZlcnNpb25zIDMuNiBhbmQgYWJvdmUsIHRoZXJlIGlzIG5vIHBlcmZvcm1hbmNlIGltcHJvdmVtZW50IGFuZFxuICAgICAgICAgKiB0aGUgbG9naWMgaXMgdW5uZWNlc3NhcnkuIFNvbWUgcXVlcnkgcGF0dGVybnMgYXJlIGV2ZW4gc2xvd2VkIGJ5XG4gICAgICAgICAqIHRoZSBiZWxvdyBsb2dpYywgZHVlIHRvIHRoZSBidWcgaGF2aW5nIGJlZW4gZml4ZWQgYW5kIGJldHRlclxuICAgICAgICAgKiBxdWVyeSBwbGFucyBiZWluZyBjaG9zZW4uXG4gICAgICAgICAqXG4gICAgICAgICAqIFdoZW4gdmVyc2lvbnMgYmVmb3JlIDMuNCBhcmUgbm8gbG9uZ2VyIHN1cHBvcnRlZCBieSB0aGlzIHByb2plY3QsXG4gICAgICAgICAqIHRoaXMgbG9naWMsIGFuZCB0aGUgYWNjb21wYW55aW5nIGBza2lwTW9uZ29EQlNlcnZlcjEzNzMyV29ya2Fyb3VuZGBcbiAgICAgICAgICogZmxhZywgY2FuIGJlIHJlbW92ZWQuXG4gICAgICAgICAqXG4gICAgICAgICAqIFRoaXMgYmxvY2sgcmVzdHJ1Y3R1cmVzIHF1ZXJpZXMgaW4gd2hpY2ggJG9yIGlzIG5vdCB0aGUgc29sZSB0b3BcbiAgICAgICAgICogbGV2ZWwgZWxlbWVudCBieSBtb3ZpbmcgYWxsIG90aGVyIHRvcC1sZXZlbCBwcmVkaWNhdGVzIGluc2lkZSBldmVyeVxuICAgICAgICAgKiBzdWJkb2N1bWVudCBvZiB0aGUgJG9yIHByZWRpY2F0ZSwgYWxsb3dpbmcgTW9uZ29EQidzIHF1ZXJ5IHBsYW5uZXJcbiAgICAgICAgICogdG8gbWFrZSBmdWxsIHVzZSBvZiB0aGUgbW9zdCByZWxldmFudCBpbmRleGVzLlxuICAgICAgICAgKlxuICAgICAgICAgKiBFRzogICAgICB7JG9yOiBbe2E6IDF9LCB7YTogMn1dLCBiOiAyfVxuICAgICAgICAgKiBCZWNvbWVzOiB7JG9yOiBbe2E6IDEsIGI6IDJ9LCB7YTogMiwgYjogMn1dfVxuICAgICAgICAgKlxuICAgICAgICAgKiBUaGUgb25seSBleGNlcHRpb25zIGFyZSAkbmVhciBhbmQgJG5lYXJTcGhlcmUgb3BlcmF0b3JzLCB3aGljaCBhcmVcbiAgICAgICAgICogY29uc3RyYWluZWQgdG8gb25seSAxIG9wZXJhdG9yIHBlciBxdWVyeS4gQXMgYSByZXN1bHQsIHRoZXNlIG9wc1xuICAgICAgICAgKiByZW1haW4gYXQgdGhlIHRvcCBsZXZlbFxuICAgICAgICAgKlxuICAgICAgICAgKiBodHRwczovL2ppcmEubW9uZ29kYi5vcmcvYnJvd3NlL1NFUlZFUi0xMzczMlxuICAgICAgICAgKiBodHRwczovL2dpdGh1Yi5jb20vcGFyc2UtY29tbXVuaXR5L3BhcnNlLXNlcnZlci9pc3N1ZXMvMzc2N1xuICAgICAgICAgKi9cbiAgICAgICAgT2JqZWN0LmtleXMocXVlcnkpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICBjb25zdCBub0NvbGxpc2lvbnMgPSAhcXVlcnkuJG9yLnNvbWUoc3VicSA9PlxuICAgICAgICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHN1YnEsIGtleSlcbiAgICAgICAgICApO1xuICAgICAgICAgIGxldCBoYXNOZWFycyA9IGZhbHNlO1xuICAgICAgICAgIGlmIChxdWVyeVtrZXldICE9IG51bGwgJiYgdHlwZW9mIHF1ZXJ5W2tleV0gPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGhhc05lYXJzID0gJyRuZWFyJyBpbiBxdWVyeVtrZXldIHx8ICckbmVhclNwaGVyZScgaW4gcXVlcnlba2V5XTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGtleSAhPSAnJG9yJyAmJiBub0NvbGxpc2lvbnMgJiYgIWhhc05lYXJzKSB7XG4gICAgICAgICAgICBxdWVyeS4kb3IuZm9yRWFjaChzdWJxdWVyeSA9PiB7XG4gICAgICAgICAgICAgIHN1YnF1ZXJ5W2tleV0gPSBxdWVyeVtrZXldO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBkZWxldGUgcXVlcnlba2V5XTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBxdWVyeS4kb3IuZm9yRWFjaChlbCA9PlxuICAgICAgICAgIHZhbGlkYXRlUXVlcnkoZWwsIHNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICdCYWQgJG9yIGZvcm1hdCAtIHVzZSBhbiBhcnJheSB2YWx1ZS4nXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGlmIChxdWVyeS4kYW5kKSB7XG4gICAgaWYgKHF1ZXJ5LiRhbmQgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgcXVlcnkuJGFuZC5mb3JFYWNoKGVsID0+XG4gICAgICAgIHZhbGlkYXRlUXVlcnkoZWwsIHNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kKVxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAnQmFkICRhbmQgZm9ybWF0IC0gdXNlIGFuIGFycmF5IHZhbHVlLidcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHF1ZXJ5LiRub3IpIHtcbiAgICBpZiAocXVlcnkuJG5vciBpbnN0YW5jZW9mIEFycmF5ICYmIHF1ZXJ5LiRub3IubGVuZ3RoID4gMCkge1xuICAgICAgcXVlcnkuJG5vci5mb3JFYWNoKGVsID0+XG4gICAgICAgIHZhbGlkYXRlUXVlcnkoZWwsIHNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kKVxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAnQmFkICRub3IgZm9ybWF0IC0gdXNlIGFuIGFycmF5IG9mIGF0IGxlYXN0IDEgdmFsdWUuJ1xuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBPYmplY3Qua2V5cyhxdWVyeSkuZm9yRWFjaChrZXkgPT4ge1xuICAgIGlmIChxdWVyeSAmJiBxdWVyeVtrZXldICYmIHF1ZXJ5W2tleV0uJHJlZ2V4KSB7XG4gICAgICBpZiAodHlwZW9mIHF1ZXJ5W2tleV0uJG9wdGlvbnMgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGlmICghcXVlcnlba2V5XS4kb3B0aW9ucy5tYXRjaCgvXltpbXhzXSskLykpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgYEJhZCAkb3B0aW9ucyB2YWx1ZSBmb3IgcXVlcnk6ICR7cXVlcnlba2V5XS4kb3B0aW9uc31gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIWlzU3BlY2lhbFF1ZXJ5S2V5KGtleSkgJiYgIWtleS5tYXRjaCgvXlthLXpBLVpdW2EtekEtWjAtOV9cXC5dKiQvKSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICBgSW52YWxpZCBrZXkgbmFtZTogJHtrZXl9YFxuICAgICAgKTtcbiAgICB9XG4gIH0pO1xufTtcblxuLy8gRmlsdGVycyBvdXQgYW55IGRhdGEgdGhhdCBzaG91bGRuJ3QgYmUgb24gdGhpcyBSRVNULWZvcm1hdHRlZCBvYmplY3QuXG5jb25zdCBmaWx0ZXJTZW5zaXRpdmVEYXRhID0gKFxuICBpc01hc3RlcjogYm9vbGVhbixcbiAgYWNsR3JvdXA6IGFueVtdLFxuICBhdXRoOiBhbnksXG4gIG9wZXJhdGlvbjogYW55LFxuICBzY2hlbWE6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlcixcbiAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gIHByb3RlY3RlZEZpZWxkczogbnVsbCB8IEFycmF5PGFueT4sXG4gIG9iamVjdDogYW55XG4pID0+IHtcbiAgbGV0IHVzZXJJZCA9IG51bGw7XG4gIGlmIChhdXRoICYmIGF1dGgudXNlcikgdXNlcklkID0gYXV0aC51c2VyLmlkO1xuXG4gIC8vIHJlcGxhY2UgcHJvdGVjdGVkRmllbGRzIHdoZW4gdXNpbmcgcG9pbnRlci1wZXJtaXNzaW9uc1xuICBjb25zdCBwZXJtcyA9IHNjaGVtYS5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lKTtcbiAgaWYgKHBlcm1zKSB7XG4gICAgY29uc3QgaXNSZWFkT3BlcmF0aW9uID0gWydnZXQnLCAnZmluZCddLmluZGV4T2Yob3BlcmF0aW9uKSA+IC0xO1xuXG4gICAgaWYgKGlzUmVhZE9wZXJhdGlvbiAmJiBwZXJtcy5wcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICAgIC8vIGV4dHJhY3QgcHJvdGVjdGVkRmllbGRzIGFkZGVkIHdpdGggdGhlIHBvaW50ZXItcGVybWlzc2lvbiBwcmVmaXhcbiAgICAgIGNvbnN0IHByb3RlY3RlZEZpZWxkc1BvaW50ZXJQZXJtID0gT2JqZWN0LmtleXMocGVybXMucHJvdGVjdGVkRmllbGRzKVxuICAgICAgICAuZmlsdGVyKGtleSA9PiBrZXkuc3RhcnRzV2l0aCgndXNlckZpZWxkOicpKVxuICAgICAgICAubWFwKGtleSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHsga2V5OiBrZXkuc3Vic3RyaW5nKDEwKSwgdmFsdWU6IHBlcm1zLnByb3RlY3RlZEZpZWxkc1trZXldIH07XG4gICAgICAgIH0pO1xuXG4gICAgICBjb25zdCBuZXdQcm90ZWN0ZWRGaWVsZHM6IEFycmF5PHN0cmluZz4gPSBbXTtcbiAgICAgIGxldCBvdmVycmlkZVByb3RlY3RlZEZpZWxkcyA9IGZhbHNlO1xuXG4gICAgICAvLyBjaGVjayBpZiB0aGUgb2JqZWN0IGdyYW50cyB0aGUgY3VycmVudCB1c2VyIGFjY2VzcyBiYXNlZCBvbiB0aGUgZXh0cmFjdGVkIGZpZWxkc1xuICAgICAgcHJvdGVjdGVkRmllbGRzUG9pbnRlclBlcm0uZm9yRWFjaChwb2ludGVyUGVybSA9PiB7XG4gICAgICAgIGxldCBwb2ludGVyUGVybUluY2x1ZGVzVXNlciA9IGZhbHNlO1xuICAgICAgICBjb25zdCByZWFkVXNlckZpZWxkVmFsdWUgPSBvYmplY3RbcG9pbnRlclBlcm0ua2V5XTtcbiAgICAgICAgaWYgKHJlYWRVc2VyRmllbGRWYWx1ZSkge1xuICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlYWRVc2VyRmllbGRWYWx1ZSkpIHtcbiAgICAgICAgICAgIHBvaW50ZXJQZXJtSW5jbHVkZXNVc2VyID0gcmVhZFVzZXJGaWVsZFZhbHVlLnNvbWUoXG4gICAgICAgICAgICAgIHVzZXIgPT4gdXNlci5vYmplY3RJZCAmJiB1c2VyLm9iamVjdElkID09PSB1c2VySWRcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBvaW50ZXJQZXJtSW5jbHVkZXNVc2VyID1cbiAgICAgICAgICAgICAgcmVhZFVzZXJGaWVsZFZhbHVlLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIHJlYWRVc2VyRmllbGRWYWx1ZS5vYmplY3RJZCA9PT0gdXNlcklkO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChwb2ludGVyUGVybUluY2x1ZGVzVXNlcikge1xuICAgICAgICAgIG92ZXJyaWRlUHJvdGVjdGVkRmllbGRzID0gdHJ1ZTtcbiAgICAgICAgICBuZXdQcm90ZWN0ZWRGaWVsZHMucHVzaCguLi5wb2ludGVyUGVybS52YWx1ZSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBpZiBhdGxlYXN0IG9uZSBwb2ludGVyLXBlcm1pc3Npb24gYWZmZWN0ZWQgdGhlIGN1cnJlbnQgdXNlciBvdmVycmlkZSB0aGUgcHJvdGVjdGVkRmllbGRzXG4gICAgICBpZiAob3ZlcnJpZGVQcm90ZWN0ZWRGaWVsZHMpIHByb3RlY3RlZEZpZWxkcyA9IG5ld1Byb3RlY3RlZEZpZWxkcztcbiAgICB9XG4gIH1cblxuICBjb25zdCBpc1VzZXJDbGFzcyA9IGNsYXNzTmFtZSA9PT0gJ19Vc2VyJztcblxuICAvKiBzcGVjaWFsIHRyZWF0IGZvciB0aGUgdXNlciBjbGFzczogZG9uJ3QgZmlsdGVyIHByb3RlY3RlZEZpZWxkcyBpZiBjdXJyZW50bHkgbG9nZ2VkaW4gdXNlciBpc1xuICB0aGUgcmV0cmlldmVkIHVzZXIgKi9cbiAgaWYgKCEoaXNVc2VyQ2xhc3MgJiYgdXNlcklkICYmIG9iamVjdC5vYmplY3RJZCA9PT0gdXNlcklkKSlcbiAgICBwcm90ZWN0ZWRGaWVsZHMgJiYgcHJvdGVjdGVkRmllbGRzLmZvckVhY2goayA9PiBkZWxldGUgb2JqZWN0W2tdKTtcblxuICBpZiAoIWlzVXNlckNsYXNzKSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIG9iamVjdC5wYXNzd29yZCA9IG9iamVjdC5faGFzaGVkX3Bhc3N3b3JkO1xuICBkZWxldGUgb2JqZWN0Ll9oYXNoZWRfcGFzc3dvcmQ7XG5cbiAgZGVsZXRlIG9iamVjdC5zZXNzaW9uVG9rZW47XG5cbiAgaWYgKGlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuICBkZWxldGUgb2JqZWN0Ll9lbWFpbF92ZXJpZnlfdG9rZW47XG4gIGRlbGV0ZSBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW47XG4gIGRlbGV0ZSBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdDtcbiAgZGVsZXRlIG9iamVjdC5fdG9tYnN0b25lO1xuICBkZWxldGUgb2JqZWN0Ll9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdDtcbiAgZGVsZXRlIG9iamVjdC5fZmFpbGVkX2xvZ2luX2NvdW50O1xuICBkZWxldGUgb2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdDtcbiAgZGVsZXRlIG9iamVjdC5fcGFzc3dvcmRfY2hhbmdlZF9hdDtcbiAgZGVsZXRlIG9iamVjdC5fcGFzc3dvcmRfaGlzdG9yeTtcblxuICBpZiAoYWNsR3JvdXAuaW5kZXhPZihvYmplY3Qub2JqZWN0SWQpID4gLTEpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIGRlbGV0ZSBvYmplY3QuYXV0aERhdGE7XG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5pbXBvcnQgdHlwZSB7IExvYWRTY2hlbWFPcHRpb25zIH0gZnJvbSAnLi90eXBlcyc7XG5cbi8vIFJ1bnMgYW4gdXBkYXRlIG9uIHRoZSBkYXRhYmFzZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhbiBvYmplY3Qgd2l0aCB0aGUgbmV3IHZhbHVlcyBmb3IgZmllbGRcbi8vIG1vZGlmaWNhdGlvbnMgdGhhdCBkb24ndCBrbm93IHRoZWlyIHJlc3VsdHMgYWhlYWQgb2YgdGltZSwgbGlrZVxuLy8gJ2luY3JlbWVudCcuXG4vLyBPcHRpb25zOlxuLy8gICBhY2w6ICBhIGxpc3Qgb2Ygc3RyaW5ncy4gSWYgdGhlIG9iamVjdCB0byBiZSB1cGRhdGVkIGhhcyBhbiBBQ0wsXG4vLyAgICAgICAgIG9uZSBvZiB0aGUgcHJvdmlkZWQgc3RyaW5ncyBtdXN0IHByb3ZpZGUgdGhlIGNhbGxlciB3aXRoXG4vLyAgICAgICAgIHdyaXRlIHBlcm1pc3Npb25zLlxuY29uc3Qgc3BlY2lhbEtleXNGb3JVcGRhdGUgPSBbXG4gICdfaGFzaGVkX3Bhc3N3b3JkJyxcbiAgJ19wZXJpc2hhYmxlX3Rva2VuJyxcbiAgJ19lbWFpbF92ZXJpZnlfdG9rZW4nLFxuICAnX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0JyxcbiAgJ19hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCcsXG4gICdfZmFpbGVkX2xvZ2luX2NvdW50JyxcbiAgJ19wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQnLFxuICAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnLFxuICAnX3Bhc3N3b3JkX2hpc3RvcnknLFxuXTtcblxuY29uc3QgaXNTcGVjaWFsVXBkYXRlS2V5ID0ga2V5ID0+IHtcbiAgcmV0dXJuIHNwZWNpYWxLZXlzRm9yVXBkYXRlLmluZGV4T2Yoa2V5KSA+PSAwO1xufTtcblxuZnVuY3Rpb24gZXhwYW5kUmVzdWx0T25LZXlQYXRoKG9iamVjdCwga2V5LCB2YWx1ZSkge1xuICBpZiAoa2V5LmluZGV4T2YoJy4nKSA8IDApIHtcbiAgICBvYmplY3Rba2V5XSA9IHZhbHVlW2tleV07XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuICBjb25zdCBwYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gIGNvbnN0IGZpcnN0S2V5ID0gcGF0aFswXTtcbiAgY29uc3QgbmV4dFBhdGggPSBwYXRoLnNsaWNlKDEpLmpvaW4oJy4nKTtcbiAgb2JqZWN0W2ZpcnN0S2V5XSA9IGV4cGFuZFJlc3VsdE9uS2V5UGF0aChcbiAgICBvYmplY3RbZmlyc3RLZXldIHx8IHt9LFxuICAgIG5leHRQYXRoLFxuICAgIHZhbHVlW2ZpcnN0S2V5XVxuICApO1xuICBkZWxldGUgb2JqZWN0W2tleV07XG4gIHJldHVybiBvYmplY3Q7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplRGF0YWJhc2VSZXN1bHQob3JpZ2luYWxPYmplY3QsIHJlc3VsdCk6IFByb21pc2U8YW55PiB7XG4gIGNvbnN0IHJlc3BvbnNlID0ge307XG4gIGlmICghcmVzdWx0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXNwb25zZSk7XG4gIH1cbiAgT2JqZWN0LmtleXMob3JpZ2luYWxPYmplY3QpLmZvckVhY2goa2V5ID0+IHtcbiAgICBjb25zdCBrZXlVcGRhdGUgPSBvcmlnaW5hbE9iamVjdFtrZXldO1xuICAgIC8vIGRldGVybWluZSBpZiB0aGF0IHdhcyBhbiBvcFxuICAgIGlmIChcbiAgICAgIGtleVVwZGF0ZSAmJlxuICAgICAgdHlwZW9mIGtleVVwZGF0ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgIGtleVVwZGF0ZS5fX29wICYmXG4gICAgICBbJ0FkZCcsICdBZGRVbmlxdWUnLCAnUmVtb3ZlJywgJ0luY3JlbWVudCddLmluZGV4T2Yoa2V5VXBkYXRlLl9fb3ApID4gLTFcbiAgICApIHtcbiAgICAgIC8vIG9ubHkgdmFsaWQgb3BzIHRoYXQgcHJvZHVjZSBhbiBhY3Rpb25hYmxlIHJlc3VsdFxuICAgICAgLy8gdGhlIG9wIG1heSBoYXZlIGhhcHBlbmQgb24gYSBrZXlwYXRoXG4gICAgICBleHBhbmRSZXN1bHRPbktleVBhdGgocmVzcG9uc2UsIGtleSwgcmVzdWx0KTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHJlc3BvbnNlKTtcbn1cblxuZnVuY3Rpb24gam9pblRhYmxlTmFtZShjbGFzc05hbWUsIGtleSkge1xuICByZXR1cm4gYF9Kb2luOiR7a2V5fToke2NsYXNzTmFtZX1gO1xufVxuXG5jb25zdCBmbGF0dGVuVXBkYXRlT3BlcmF0b3JzRm9yQ3JlYXRlID0gb2JqZWN0ID0+IHtcbiAgZm9yIChjb25zdCBrZXkgaW4gb2JqZWN0KSB7XG4gICAgaWYgKG9iamVjdFtrZXldICYmIG9iamVjdFtrZXldLl9fb3ApIHtcbiAgICAgIHN3aXRjaCAob2JqZWN0W2tleV0uX19vcCkge1xuICAgICAgICBjYXNlICdJbmNyZW1lbnQnOlxuICAgICAgICAgIGlmICh0eXBlb2Ygb2JqZWN0W2tleV0uYW1vdW50ICE9PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5J1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5hbW91bnQ7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0FkZCc6XG4gICAgICAgICAgaWYgKCEob2JqZWN0W2tleV0ub2JqZWN0cyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5J1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5vYmplY3RzO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdBZGRVbmlxdWUnOlxuICAgICAgICAgIGlmICghKG9iamVjdFtrZXldLm9iamVjdHMgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgICAnb2JqZWN0cyB0byBhZGQgbXVzdCBiZSBhbiBhcnJheSdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9iamVjdFtrZXldID0gb2JqZWN0W2tleV0ub2JqZWN0cztcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnUmVtb3ZlJzpcbiAgICAgICAgICBpZiAoIShvYmplY3Rba2V5XS5vYmplY3RzIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3Rba2V5XSA9IFtdO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdEZWxldGUnOlxuICAgICAgICAgIGRlbGV0ZSBvYmplY3Rba2V5XTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5DT01NQU5EX1VOQVZBSUxBQkxFLFxuICAgICAgICAgICAgYFRoZSAke29iamVjdFtrZXldLl9fb3B9IG9wZXJhdG9yIGlzIG5vdCBzdXBwb3J0ZWQgeWV0LmBcbiAgICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuY29uc3QgdHJhbnNmb3JtQXV0aERhdGEgPSAoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkgPT4ge1xuICBpZiAob2JqZWN0LmF1dGhEYXRhICYmIGNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIE9iamVjdC5rZXlzKG9iamVjdC5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICBjb25zdCBwcm92aWRlckRhdGEgPSBvYmplY3QuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgY29uc3QgZmllbGROYW1lID0gYF9hdXRoX2RhdGFfJHtwcm92aWRlcn1gO1xuICAgICAgaWYgKHByb3ZpZGVyRGF0YSA9PSBudWxsKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fb3A6ICdEZWxldGUnLFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSBwcm92aWRlckRhdGE7XG4gICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSA9IHsgdHlwZTogJ09iamVjdCcgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBkZWxldGUgb2JqZWN0LmF1dGhEYXRhO1xuICB9XG59O1xuLy8gVHJhbnNmb3JtcyBhIERhdGFiYXNlIGZvcm1hdCBBQ0wgdG8gYSBSRVNUIEFQSSBmb3JtYXQgQUNMXG5jb25zdCB1bnRyYW5zZm9ybU9iamVjdEFDTCA9ICh7IF9ycGVybSwgX3dwZXJtLCAuLi5vdXRwdXQgfSkgPT4ge1xuICBpZiAoX3JwZXJtIHx8IF93cGVybSkge1xuICAgIG91dHB1dC5BQ0wgPSB7fTtcblxuICAgIChfcnBlcm0gfHwgW10pLmZvckVhY2goZW50cnkgPT4ge1xuICAgICAgaWYgKCFvdXRwdXQuQUNMW2VudHJ5XSkge1xuICAgICAgICBvdXRwdXQuQUNMW2VudHJ5XSA9IHsgcmVhZDogdHJ1ZSB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV1bJ3JlYWQnXSA9IHRydWU7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAoX3dwZXJtIHx8IFtdKS5mb3JFYWNoKGVudHJ5ID0+IHtcbiAgICAgIGlmICghb3V0cHV0LkFDTFtlbnRyeV0pIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV0gPSB7IHdyaXRlOiB0cnVlIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvdXRwdXQuQUNMW2VudHJ5XVsnd3JpdGUnXSA9IHRydWU7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG91dHB1dDtcbn07XG5cbi8qKlxuICogV2hlbiBxdWVyeWluZywgdGhlIGZpZWxkTmFtZSBtYXkgYmUgY29tcG91bmQsIGV4dHJhY3QgdGhlIHJvb3QgZmllbGROYW1lXG4gKiAgICAgYHRlbXBlcmF0dXJlLmNlbHNpdXNgIGJlY29tZXMgYHRlbXBlcmF0dXJlYFxuICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSB0aGF0IG1heSBiZSBhIGNvbXBvdW5kIGZpZWxkIG5hbWVcbiAqIEByZXR1cm5zIHtzdHJpbmd9IHRoZSByb290IG5hbWUgb2YgdGhlIGZpZWxkXG4gKi9cbmNvbnN0IGdldFJvb3RGaWVsZE5hbWUgPSAoZmllbGROYW1lOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICByZXR1cm4gZmllbGROYW1lLnNwbGl0KCcuJylbMF07XG59O1xuXG5jb25zdCByZWxhdGlvblNjaGVtYSA9IHtcbiAgZmllbGRzOiB7IHJlbGF0ZWRJZDogeyB0eXBlOiAnU3RyaW5nJyB9LCBvd25pbmdJZDogeyB0eXBlOiAnU3RyaW5nJyB9IH0sXG59O1xuXG5jbGFzcyBEYXRhYmFzZUNvbnRyb2xsZXIge1xuICBhZGFwdGVyOiBTdG9yYWdlQWRhcHRlcjtcbiAgc2NoZW1hQ2FjaGU6IGFueTtcbiAgc2NoZW1hUHJvbWlzZTogP1Byb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPjtcbiAgc2tpcE1vbmdvREJTZXJ2ZXIxMzczMldvcmthcm91bmQ6IGJvb2xlYW47XG4gIF90cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBhZGFwdGVyOiBTdG9yYWdlQWRhcHRlcixcbiAgICBzY2hlbWFDYWNoZTogYW55LFxuICAgIHNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kOiBib29sZWFuXG4gICkge1xuICAgIHRoaXMuYWRhcHRlciA9IGFkYXB0ZXI7XG4gICAgdGhpcy5zY2hlbWFDYWNoZSA9IHNjaGVtYUNhY2hlO1xuICAgIC8vIFdlIGRvbid0IHdhbnQgYSBtdXRhYmxlIHRoaXMuc2NoZW1hLCBiZWNhdXNlIHRoZW4geW91IGNvdWxkIGhhdmVcbiAgICAvLyBvbmUgcmVxdWVzdCB0aGF0IHVzZXMgZGlmZmVyZW50IHNjaGVtYXMgZm9yIGRpZmZlcmVudCBwYXJ0cyBvZlxuICAgIC8vIGl0LiBJbnN0ZWFkLCB1c2UgbG9hZFNjaGVtYSB0byBnZXQgYSBzY2hlbWEuXG4gICAgdGhpcy5zY2hlbWFQcm9taXNlID0gbnVsbDtcbiAgICB0aGlzLnNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kID0gc2tpcE1vbmdvREJTZXJ2ZXIxMzczMldvcmthcm91bmQ7XG4gICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSBudWxsO1xuICB9XG5cbiAgY29sbGVjdGlvbkV4aXN0cyhjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuY2xhc3NFeGlzdHMoY2xhc3NOYW1lKTtcbiAgfVxuXG4gIHB1cmdlQ29sbGVjdGlvbihjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUpKVxuICAgICAgLnRoZW4oc2NoZW1hID0+IHRoaXMuYWRhcHRlci5kZWxldGVPYmplY3RzQnlRdWVyeShjbGFzc05hbWUsIHNjaGVtYSwge30pKTtcbiAgfVxuXG4gIHZhbGlkYXRlQ2xhc3NOYW1lKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFTY2hlbWFDb250cm9sbGVyLmNsYXNzTmFtZUlzVmFsaWQoY2xhc3NOYW1lKSkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9DTEFTU19OQU1FLFxuICAgICAgICAgICdpbnZhbGlkIGNsYXNzTmFtZTogJyArIGNsYXNzTmFtZVxuICAgICAgICApXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSBzY2hlbWFDb250cm9sbGVyLlxuICBsb2FkU2NoZW1hKFxuICAgIG9wdGlvbnM6IExvYWRTY2hlbWFPcHRpb25zID0geyBjbGVhckNhY2hlOiBmYWxzZSB9XG4gICk6IFByb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPiB7XG4gICAgaWYgKHRoaXMuc2NoZW1hUHJvbWlzZSAhPSBudWxsKSB7XG4gICAgICByZXR1cm4gdGhpcy5zY2hlbWFQcm9taXNlO1xuICAgIH1cbiAgICB0aGlzLnNjaGVtYVByb21pc2UgPSBTY2hlbWFDb250cm9sbGVyLmxvYWQoXG4gICAgICB0aGlzLmFkYXB0ZXIsXG4gICAgICB0aGlzLnNjaGVtYUNhY2hlLFxuICAgICAgb3B0aW9uc1xuICAgICk7XG4gICAgdGhpcy5zY2hlbWFQcm9taXNlLnRoZW4oXG4gICAgICAoKSA9PiBkZWxldGUgdGhpcy5zY2hlbWFQcm9taXNlLFxuICAgICAgKCkgPT4gZGVsZXRlIHRoaXMuc2NoZW1hUHJvbWlzZVxuICAgICk7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYShvcHRpb25zKTtcbiAgfVxuXG4gIGxvYWRTY2hlbWFJZk5lZWRlZChcbiAgICBzY2hlbWFDb250cm9sbGVyOiBTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXIsXG4gICAgb3B0aW9uczogTG9hZFNjaGVtYU9wdGlvbnMgPSB7IGNsZWFyQ2FjaGU6IGZhbHNlIH1cbiAgKTogUHJvbWlzZTxTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXI+IHtcbiAgICByZXR1cm4gc2NoZW1hQ29udHJvbGxlclxuICAgICAgPyBQcm9taXNlLnJlc29sdmUoc2NoZW1hQ29udHJvbGxlcilcbiAgICAgIDogdGhpcy5sb2FkU2NoZW1hKG9wdGlvbnMpO1xuICB9XG5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHRoZSBjbGFzc25hbWUgdGhhdCBpcyByZWxhdGVkIHRvIHRoZSBnaXZlblxuICAvLyBjbGFzc25hbWUgdGhyb3VnaCB0aGUga2V5LlxuICAvLyBUT0RPOiBtYWtlIHRoaXMgbm90IGluIHRoZSBEYXRhYmFzZUNvbnRyb2xsZXIgaW50ZXJmYWNlXG4gIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5KGNsYXNzTmFtZTogc3RyaW5nLCBrZXk6IHN0cmluZyk6IFByb21pc2U8P3N0cmluZz4ge1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYSA9PiB7XG4gICAgICB2YXIgdCA9IHNjaGVtYS5nZXRFeHBlY3RlZFR5cGUoY2xhc3NOYW1lLCBrZXkpO1xuICAgICAgaWYgKHQgIT0gbnVsbCAmJiB0eXBlb2YgdCAhPT0gJ3N0cmluZycgJiYgdC50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHJldHVybiB0LnRhcmdldENsYXNzO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGNsYXNzTmFtZTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFVzZXMgdGhlIHNjaGVtYSB0byB2YWxpZGF0ZSB0aGUgb2JqZWN0IChSRVNUIEFQSSBmb3JtYXQpLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBuZXcgc2NoZW1hLlxuICAvLyBUaGlzIGRvZXMgbm90IHVwZGF0ZSB0aGlzLnNjaGVtYSwgYmVjYXVzZSBpbiBhIHNpdHVhdGlvbiBsaWtlIGFcbiAgLy8gYmF0Y2ggcmVxdWVzdCwgdGhhdCBjb3VsZCBjb25mdXNlIG90aGVyIHVzZXJzIG9mIHRoZSBzY2hlbWEuXG4gIHZhbGlkYXRlT2JqZWN0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9iamVjdDogYW55LFxuICAgIHF1ZXJ5OiBhbnksXG4gICAgeyBhY2wgfTogUXVlcnlPcHRpb25zXG4gICk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGxldCBzY2hlbWE7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICB2YXIgYWNsR3JvdXA6IHN0cmluZ1tdID0gYWNsIHx8IFtdO1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4ocyA9PiB7XG4gICAgICAgIHNjaGVtYSA9IHM7XG4gICAgICAgIGlmIChpc01hc3Rlcikge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5jYW5BZGRGaWVsZChzY2hlbWEsIGNsYXNzTmFtZSwgb2JqZWN0LCBhY2xHcm91cCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gc2NoZW1hLnZhbGlkYXRlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBxdWVyeSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIHVwZGF0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHsgYWNsLCBtYW55LCB1cHNlcnQgfTogRnVsbFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHNraXBTYW5pdGl6YXRpb246IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZGF0ZU9ubHk6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IG9yaWdpbmFsUXVlcnkgPSBxdWVyeTtcbiAgICBjb25zdCBvcmlnaW5hbFVwZGF0ZSA9IHVwZGF0ZTtcbiAgICAvLyBNYWtlIGEgY29weSBvZiB0aGUgb2JqZWN0LCBzbyB3ZSBkb24ndCBtdXRhdGUgdGhlIGluY29taW5nIGRhdGEuXG4gICAgdXBkYXRlID0gZGVlcGNvcHkodXBkYXRlKTtcbiAgICB2YXIgcmVsYXRpb25VcGRhdGVzID0gW107XG4gICAgdmFyIGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQ7XG4gICAgdmFyIGFjbEdyb3VwID0gYWNsIHx8IFtdO1xuXG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcikudGhlbihcbiAgICAgIHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgICByZXR1cm4gKGlzTWFzdGVyXG4gICAgICAgICAgPyBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgICAgIDogc2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ3VwZGF0ZScpXG4gICAgICAgIClcbiAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICByZWxhdGlvblVwZGF0ZXMgPSB0aGlzLmNvbGxlY3RSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgb3JpZ2luYWxRdWVyeS5vYmplY3RJZCxcbiAgICAgICAgICAgICAgdXBkYXRlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgICBxdWVyeSA9IHRoaXMuYWRkUG9pbnRlclBlcm1pc3Npb25zKFxuICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICd1cGRhdGUnLFxuICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIXF1ZXJ5KSB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhY2wpIHtcbiAgICAgICAgICAgICAgcXVlcnkgPSBhZGRXcml0ZUFDTChxdWVyeSwgYWNsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhbGlkYXRlUXVlcnkocXVlcnksIHRoaXMuc2tpcE1vbmdvREJTZXJ2ZXIxMzczMldvcmthcm91bmQpO1xuICAgICAgICAgICAgcmV0dXJuIHNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgICAgICAgLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpXG4gICAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgICAgLy8gSWYgdGhlIHNjaGVtYSBkb2Vzbid0IGV4aXN0LCBwcmV0ZW5kIGl0IGV4aXN0cyB3aXRoIG5vIGZpZWxkcy4gVGhpcyBiZWhhdmlvclxuICAgICAgICAgICAgICAgIC8vIHdpbGwgbGlrZWx5IG5lZWQgcmV2aXNpdGluZy5cbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgZmllbGRzOiB7fSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgICAgICAgICAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUubWF0Y2goL15hdXRoRGF0YVxcLihbYS16QS1aMC05X10rKVxcLmlkJC8pKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIGZpZWxkIG5hbWUgZm9yIHVwZGF0ZTogJHtmaWVsZE5hbWV9YFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgY29uc3Qgcm9vdEZpZWxkTmFtZSA9IGdldFJvb3RGaWVsZE5hbWUoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lKSAmJlxuICAgICAgICAgICAgICAgICAgICAhaXNTcGVjaWFsVXBkYXRlS2V5KHJvb3RGaWVsZE5hbWUpXG4gICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgZmllbGQgbmFtZSBmb3IgdXBkYXRlOiAke2ZpZWxkTmFtZX1gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCB1cGRhdGVPcGVyYXRpb24gaW4gdXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZVt1cGRhdGVPcGVyYXRpb25dICYmXG4gICAgICAgICAgICAgICAgICAgIHR5cGVvZiB1cGRhdGVbdXBkYXRlT3BlcmF0aW9uXSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmtleXModXBkYXRlW3VwZGF0ZU9wZXJhdGlvbl0pLnNvbWUoXG4gICAgICAgICAgICAgICAgICAgICAgaW5uZXJLZXkgPT5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlubmVyS2V5LmluY2x1ZGVzKCckJykgfHwgaW5uZXJLZXkuaW5jbHVkZXMoJy4nKVxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfTkVTVEVEX0tFWSxcbiAgICAgICAgICAgICAgICAgICAgICBcIk5lc3RlZCBrZXlzIHNob3VsZCBub3QgY29udGFpbiB0aGUgJyQnIG9yICcuJyBjaGFyYWN0ZXJzXCJcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdXBkYXRlID0gdHJhbnNmb3JtT2JqZWN0QUNMKHVwZGF0ZSk7XG4gICAgICAgICAgICAgICAgdHJhbnNmb3JtQXV0aERhdGEoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgICAgICAgICAgICAgaWYgKHZhbGlkYXRlT25seSkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgICAgICAgICAgICAgICAuZmluZChjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHt9KVxuICAgICAgICAgICAgICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGlmICghcmVzdWx0IHx8ICFyZXN1bHQubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChtYW55KSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLnVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZSxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh1cHNlcnQpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZSxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZmluZE9uZUFuZFVwZGF0ZShcbiAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbigocmVzdWx0OiBhbnkpID0+IHtcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmhhbmRsZVJlbGF0aW9uVXBkYXRlcyhcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBvcmlnaW5hbFF1ZXJ5Lm9iamVjdElkLFxuICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgIHJlbGF0aW9uVXBkYXRlc1xuICAgICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgICAgIGlmIChza2lwU2FuaXRpemF0aW9uKSB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzYW5pdGl6ZURhdGFiYXNlUmVzdWx0KG9yaWdpbmFsVXBkYXRlLCByZXN1bHQpO1xuICAgICAgICAgIH0pO1xuICAgICAgfVxuICAgICk7XG4gIH1cblxuICAvLyBDb2xsZWN0IGFsbCByZWxhdGlvbi11cGRhdGluZyBvcGVyYXRpb25zIGZyb20gYSBSRVNULWZvcm1hdCB1cGRhdGUuXG4gIC8vIFJldHVybnMgYSBsaXN0IG9mIGFsbCByZWxhdGlvbiB1cGRhdGVzIHRvIHBlcmZvcm1cbiAgLy8gVGhpcyBtdXRhdGVzIHVwZGF0ZS5cbiAgY29sbGVjdFJlbGF0aW9uVXBkYXRlcyhjbGFzc05hbWU6IHN0cmluZywgb2JqZWN0SWQ6ID9zdHJpbmcsIHVwZGF0ZTogYW55KSB7XG4gICAgdmFyIG9wcyA9IFtdO1xuICAgIHZhciBkZWxldGVNZSA9IFtdO1xuICAgIG9iamVjdElkID0gdXBkYXRlLm9iamVjdElkIHx8IG9iamVjdElkO1xuXG4gICAgdmFyIHByb2Nlc3MgPSAob3AsIGtleSkgPT4ge1xuICAgICAgaWYgKCFvcCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAob3AuX19vcCA9PSAnQWRkUmVsYXRpb24nKSB7XG4gICAgICAgIG9wcy5wdXNoKHsga2V5LCBvcCB9KTtcbiAgICAgICAgZGVsZXRlTWUucHVzaChrZXkpO1xuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnUmVtb3ZlUmVsYXRpb24nKSB7XG4gICAgICAgIG9wcy5wdXNoKHsga2V5LCBvcCB9KTtcbiAgICAgICAgZGVsZXRlTWUucHVzaChrZXkpO1xuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnQmF0Y2gnKSB7XG4gICAgICAgIGZvciAodmFyIHggb2Ygb3Aub3BzKSB7XG4gICAgICAgICAgcHJvY2Vzcyh4LCBrZXkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcblxuICAgIGZvciAoY29uc3Qga2V5IGluIHVwZGF0ZSkge1xuICAgICAgcHJvY2Vzcyh1cGRhdGVba2V5XSwga2V5KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBrZXkgb2YgZGVsZXRlTWUpIHtcbiAgICAgIGRlbGV0ZSB1cGRhdGVba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIG9wcztcbiAgfVxuXG4gIC8vIFByb2Nlc3NlcyByZWxhdGlvbi11cGRhdGluZyBvcGVyYXRpb25zIGZyb20gYSBSRVNULWZvcm1hdCB1cGRhdGUuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBhbGwgdXBkYXRlcyBoYXZlIGJlZW4gcGVyZm9ybWVkXG4gIGhhbmRsZVJlbGF0aW9uVXBkYXRlcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3RJZDogc3RyaW5nLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIG9wczogYW55XG4gICkge1xuICAgIHZhciBwZW5kaW5nID0gW107XG4gICAgb2JqZWN0SWQgPSB1cGRhdGUub2JqZWN0SWQgfHwgb2JqZWN0SWQ7XG4gICAgb3BzLmZvckVhY2goKHsga2V5LCBvcCB9KSA9PiB7XG4gICAgICBpZiAoIW9wKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChvcC5fX29wID09ICdBZGRSZWxhdGlvbicpIHtcbiAgICAgICAgZm9yIChjb25zdCBvYmplY3Qgb2Ygb3Aub2JqZWN0cykge1xuICAgICAgICAgIHBlbmRpbmcucHVzaChcbiAgICAgICAgICAgIHRoaXMuYWRkUmVsYXRpb24oa2V5LCBjbGFzc05hbWUsIG9iamVjdElkLCBvYmplY3Qub2JqZWN0SWQpXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnUmVtb3ZlUmVsYXRpb24nKSB7XG4gICAgICAgIGZvciAoY29uc3Qgb2JqZWN0IG9mIG9wLm9iamVjdHMpIHtcbiAgICAgICAgICBwZW5kaW5nLnB1c2goXG4gICAgICAgICAgICB0aGlzLnJlbW92ZVJlbGF0aW9uKGtleSwgY2xhc3NOYW1lLCBvYmplY3RJZCwgb2JqZWN0Lm9iamVjdElkKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBQcm9taXNlLmFsbChwZW5kaW5nKTtcbiAgfVxuXG4gIC8vIEFkZHMgYSByZWxhdGlvbi5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBhZGQgd2FzIHN1Y2Nlc3NmdWwuXG4gIGFkZFJlbGF0aW9uKFxuICAgIGtleTogc3RyaW5nLFxuICAgIGZyb21DbGFzc05hbWU6IHN0cmluZyxcbiAgICBmcm9tSWQ6IHN0cmluZyxcbiAgICB0b0lkOiBzdHJpbmdcbiAgKSB7XG4gICAgY29uc3QgZG9jID0ge1xuICAgICAgcmVsYXRlZElkOiB0b0lkLFxuICAgICAgb3duaW5nSWQ6IGZyb21JZCxcbiAgICB9O1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgYF9Kb2luOiR7a2V5fToke2Zyb21DbGFzc05hbWV9YCxcbiAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgZG9jLFxuICAgICAgZG9jLFxuICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICApO1xuICB9XG5cbiAgLy8gUmVtb3ZlcyBhIHJlbGF0aW9uLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSBpZmYgdGhlIHJlbW92ZSB3YXNcbiAgLy8gc3VjY2Vzc2Z1bC5cbiAgcmVtb3ZlUmVsYXRpb24oXG4gICAga2V5OiBzdHJpbmcsXG4gICAgZnJvbUNsYXNzTmFtZTogc3RyaW5nLFxuICAgIGZyb21JZDogc3RyaW5nLFxuICAgIHRvSWQ6IHN0cmluZ1xuICApIHtcbiAgICB2YXIgZG9jID0ge1xuICAgICAgcmVsYXRlZElkOiB0b0lkLFxuICAgICAgb3duaW5nSWQ6IGZyb21JZCxcbiAgICB9O1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5kZWxldGVPYmplY3RzQnlRdWVyeShcbiAgICAgICAgYF9Kb2luOiR7a2V5fToke2Zyb21DbGFzc05hbWV9YCxcbiAgICAgICAgcmVsYXRpb25TY2hlbWEsXG4gICAgICAgIGRvYyxcbiAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIC8vIFdlIGRvbid0IGNhcmUgaWYgdGhleSB0cnkgdG8gZGVsZXRlIGEgbm9uLWV4aXN0ZW50IHJlbGF0aW9uLlxuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gIH1cblxuICAvLyBSZW1vdmVzIG9iamVjdHMgbWF0Y2hlcyB0aGlzIHF1ZXJ5IGZyb20gdGhlIGRhdGFiYXNlLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSBpZmYgdGhlIG9iamVjdCB3YXNcbiAgLy8gZGVsZXRlZC5cbiAgLy8gT3B0aW9uczpcbiAgLy8gICBhY2w6ICBhIGxpc3Qgb2Ygc3RyaW5ncy4gSWYgdGhlIG9iamVjdCB0byBiZSB1cGRhdGVkIGhhcyBhbiBBQ0wsXG4gIC8vICAgICAgICAgb25lIG9mIHRoZSBwcm92aWRlZCBzdHJpbmdzIG11c3QgcHJvdmlkZSB0aGUgY2FsbGVyIHdpdGhcbiAgLy8gICAgICAgICB3cml0ZSBwZXJtaXNzaW9ucy5cbiAgZGVzdHJveShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIHsgYWNsIH06IFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY2xHcm91cCA9IGFjbCB8fCBbXTtcblxuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWFJZk5lZWRlZCh2YWxpZFNjaGVtYUNvbnRyb2xsZXIpLnRoZW4oXG4gICAgICBzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdkZWxldGUnKVxuICAgICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIGlmICghaXNNYXN0ZXIpIHtcbiAgICAgICAgICAgIHF1ZXJ5ID0gdGhpcy5hZGRQb2ludGVyUGVybWlzc2lvbnMoXG4gICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgJ2RlbGV0ZScsXG4gICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICBhY2xHcm91cFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBkZWxldGUgYnkgcXVlcnlcbiAgICAgICAgICBpZiAoYWNsKSB7XG4gICAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB2YWxpZGF0ZVF1ZXJ5KHF1ZXJ5LCB0aGlzLnNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kKTtcbiAgICAgICAgICByZXR1cm4gc2NoZW1hQ29udHJvbGxlclxuICAgICAgICAgICAgLmdldE9uZVNjaGVtYShjbGFzc05hbWUpXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICAvLyBJZiB0aGUgc2NoZW1hIGRvZXNuJ3QgZXhpc3QsIHByZXRlbmQgaXQgZXhpc3RzIHdpdGggbm8gZmllbGRzLiBUaGlzIGJlaGF2aW9yXG4gICAgICAgICAgICAgIC8vIHdpbGwgbGlrZWx5IG5lZWQgcmV2aXNpdGluZy5cbiAgICAgICAgICAgICAgaWYgKGVycm9yID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBmaWVsZHM6IHt9IH07XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLnRoZW4ocGFyc2VGb3JtYXRTY2hlbWEgPT5cbiAgICAgICAgICAgICAgdGhpcy5hZGFwdGVyLmRlbGV0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICBwYXJzZUZvcm1hdFNjaGVtYSxcbiAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICAvLyBXaGVuIGRlbGV0aW5nIHNlc3Npb25zIHdoaWxlIGNoYW5naW5nIHBhc3N3b3JkcywgZG9uJ3QgdGhyb3cgYW4gZXJyb3IgaWYgdGhleSBkb24ndCBoYXZlIGFueSBzZXNzaW9ucy5cbiAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZSA9PT0gJ19TZXNzaW9uJyAmJlxuICAgICAgICAgICAgICAgIGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkRcbiAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgKTtcbiAgfVxuXG4gIC8vIEluc2VydHMgYW4gb2JqZWN0IGludG8gdGhlIGRhdGFiYXNlLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSBpZmYgdGhlIG9iamVjdCBzYXZlZC5cbiAgY3JlYXRlKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9iamVjdDogYW55LFxuICAgIHsgYWNsIH06IFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHZhbGlkYXRlT25seTogYm9vbGVhbiA9IGZhbHNlLFxuICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgLy8gTWFrZSBhIGNvcHkgb2YgdGhlIG9iamVjdCwgc28gd2UgZG9uJ3QgbXV0YXRlIHRoZSBpbmNvbWluZyBkYXRhLlxuICAgIGNvbnN0IG9yaWdpbmFsT2JqZWN0ID0gb2JqZWN0O1xuICAgIG9iamVjdCA9IHRyYW5zZm9ybU9iamVjdEFDTChvYmplY3QpO1xuXG4gICAgb2JqZWN0LmNyZWF0ZWRBdCA9IHsgaXNvOiBvYmplY3QuY3JlYXRlZEF0LCBfX3R5cGU6ICdEYXRlJyB9O1xuICAgIG9iamVjdC51cGRhdGVkQXQgPSB7IGlzbzogb2JqZWN0LnVwZGF0ZWRBdCwgX190eXBlOiAnRGF0ZScgfTtcblxuICAgIHZhciBpc01hc3RlciA9IGFjbCA9PT0gdW5kZWZpbmVkO1xuICAgIHZhciBhY2xHcm91cCA9IGFjbCB8fCBbXTtcbiAgICBjb25zdCByZWxhdGlvblVwZGF0ZXMgPSB0aGlzLmNvbGxlY3RSZWxhdGlvblVwZGF0ZXMoXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBudWxsLFxuICAgICAgb2JqZWN0XG4gICAgKTtcblxuICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xhc3NOYW1lKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcikpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdjcmVhdGUnKVxuICAgICAgICApXG4gICAgICAgICAgLnRoZW4oKCkgPT4gc2NoZW1hQ29udHJvbGxlci5lbmZvcmNlQ2xhc3NFeGlzdHMoY2xhc3NOYW1lKSlcbiAgICAgICAgICAudGhlbigoKSA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpKVxuICAgICAgICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICAgICAgICB0cmFuc2Zvcm1BdXRoRGF0YShjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgICAgIGZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUob2JqZWN0KTtcbiAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jcmVhdGVPYmplY3QoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgU2NoZW1hQ29udHJvbGxlci5jb252ZXJ0U2NoZW1hVG9BZGFwdGVyU2NoZW1hKHNjaGVtYSksXG4gICAgICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbGlkYXRlT25seSkge1xuICAgICAgICAgICAgICByZXR1cm4gb3JpZ2luYWxPYmplY3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5oYW5kbGVSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0Lm9iamVjdElkLFxuICAgICAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgICAgIHJlbGF0aW9uVXBkYXRlc1xuICAgICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgcmV0dXJuIHNhbml0aXplRGF0YWJhc2VSZXN1bHQob3JpZ2luYWxPYmplY3QsIHJlc3VsdC5vcHNbMF0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNhbkFkZEZpZWxkKFxuICAgIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9iamVjdDogYW55LFxuICAgIGFjbEdyb3VwOiBzdHJpbmdbXVxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBjbGFzc1NjaGVtYSA9IHNjaGVtYS5zY2hlbWFEYXRhW2NsYXNzTmFtZV07XG4gICAgaWYgKCFjbGFzc1NjaGVtYSkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBjb25zdCBmaWVsZHMgPSBPYmplY3Qua2V5cyhvYmplY3QpO1xuICAgIGNvbnN0IHNjaGVtYUZpZWxkcyA9IE9iamVjdC5rZXlzKGNsYXNzU2NoZW1hLmZpZWxkcyk7XG4gICAgY29uc3QgbmV3S2V5cyA9IGZpZWxkcy5maWx0ZXIoZmllbGQgPT4ge1xuICAgICAgLy8gU2tpcCBmaWVsZHMgdGhhdCBhcmUgdW5zZXRcbiAgICAgIGlmIChcbiAgICAgICAgb2JqZWN0W2ZpZWxkXSAmJlxuICAgICAgICBvYmplY3RbZmllbGRdLl9fb3AgJiZcbiAgICAgICAgb2JqZWN0W2ZpZWxkXS5fX29wID09PSAnRGVsZXRlJ1xuICAgICAgKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzY2hlbWFGaWVsZHMuaW5kZXhPZihmaWVsZCkgPCAwO1xuICAgIH0pO1xuICAgIGlmIChuZXdLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgIHJldHVybiBzY2hlbWEudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdhZGRGaWVsZCcpO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBXb24ndCBkZWxldGUgY29sbGVjdGlvbnMgaW4gdGhlIHN5c3RlbSBuYW1lc3BhY2VcbiAgLyoqXG4gICAqIERlbGV0ZSBhbGwgY2xhc3NlcyBhbmQgY2xlYXJzIHRoZSBzY2hlbWEgY2FjaGVcbiAgICpcbiAgICogQHBhcmFtIHtib29sZWFufSBmYXN0IHNldCB0byB0cnVlIGlmIGl0J3Mgb2sgdG8ganVzdCBkZWxldGUgcm93cyBhbmQgbm90IGluZGV4ZXNcbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59IHdoZW4gdGhlIGRlbGV0aW9ucyBjb21wbGV0ZXNcbiAgICovXG4gIGRlbGV0ZUV2ZXJ5dGhpbmcoZmFzdDogYm9vbGVhbiA9IGZhbHNlKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0aGlzLnNjaGVtYVByb21pc2UgPSBudWxsO1xuICAgIHJldHVybiBQcm9taXNlLmFsbChbXG4gICAgICB0aGlzLmFkYXB0ZXIuZGVsZXRlQWxsQ2xhc3NlcyhmYXN0KSxcbiAgICAgIHRoaXMuc2NoZW1hQ2FjaGUuY2xlYXIoKSxcbiAgICBdKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIGxpc3Qgb2YgcmVsYXRlZCBpZHMgZ2l2ZW4gYW4gb3duaW5nIGlkLlxuICAvLyBjbGFzc05hbWUgaGVyZSBpcyB0aGUgb3duaW5nIGNsYXNzTmFtZS5cbiAgcmVsYXRlZElkcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBrZXk6IHN0cmluZyxcbiAgICBvd25pbmdJZDogc3RyaW5nLFxuICAgIHF1ZXJ5T3B0aW9uczogUXVlcnlPcHRpb25zXG4gICk6IFByb21pc2U8QXJyYXk8c3RyaW5nPj4ge1xuICAgIGNvbnN0IHsgc2tpcCwgbGltaXQsIHNvcnQgfSA9IHF1ZXJ5T3B0aW9ucztcbiAgICBjb25zdCBmaW5kT3B0aW9ucyA9IHt9O1xuICAgIGlmIChzb3J0ICYmIHNvcnQuY3JlYXRlZEF0ICYmIHRoaXMuYWRhcHRlci5jYW5Tb3J0T25Kb2luVGFibGVzKSB7XG4gICAgICBmaW5kT3B0aW9ucy5zb3J0ID0geyBfaWQ6IHNvcnQuY3JlYXRlZEF0IH07XG4gICAgICBmaW5kT3B0aW9ucy5saW1pdCA9IGxpbWl0O1xuICAgICAgZmluZE9wdGlvbnMuc2tpcCA9IHNraXA7XG4gICAgICBxdWVyeU9wdGlvbnMuc2tpcCA9IDA7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5maW5kKFxuICAgICAgICBqb2luVGFibGVOYW1lKGNsYXNzTmFtZSwga2V5KSxcbiAgICAgICAgcmVsYXRpb25TY2hlbWEsXG4gICAgICAgIHsgb3duaW5nSWQgfSxcbiAgICAgICAgZmluZE9wdGlvbnNcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4gcmVzdWx0cy5tYXAocmVzdWx0ID0+IHJlc3VsdC5yZWxhdGVkSWQpKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIGxpc3Qgb2Ygb3duaW5nIGlkcyBnaXZlbiBzb21lIHJlbGF0ZWQgaWRzLlxuICAvLyBjbGFzc05hbWUgaGVyZSBpcyB0aGUgb3duaW5nIGNsYXNzTmFtZS5cbiAgb3duaW5nSWRzKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIGtleTogc3RyaW5nLFxuICAgIHJlbGF0ZWRJZHM6IHN0cmluZ1tdXG4gICk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuZmluZChcbiAgICAgICAgam9pblRhYmxlTmFtZShjbGFzc05hbWUsIGtleSksXG4gICAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgICB7IHJlbGF0ZWRJZDogeyAkaW46IHJlbGF0ZWRJZHMgfSB9LFxuICAgICAgICB7fVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiByZXN1bHRzLm1hcChyZXN1bHQgPT4gcmVzdWx0Lm93bmluZ0lkKSk7XG4gIH1cblxuICAvLyBNb2RpZmllcyBxdWVyeSBzbyB0aGF0IGl0IG5vIGxvbmdlciBoYXMgJGluIG9uIHJlbGF0aW9uIGZpZWxkcywgb3JcbiAgLy8gZXF1YWwtdG8tcG9pbnRlciBjb25zdHJhaW50cyBvbiByZWxhdGlvbiBmaWVsZHMuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBxdWVyeSBpcyBtdXRhdGVkXG4gIHJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lOiBzdHJpbmcsIHF1ZXJ5OiBhbnksIHNjaGVtYTogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgICAvLyBTZWFyY2ggZm9yIGFuIGluLXJlbGF0aW9uIG9yIGVxdWFsLXRvLXJlbGF0aW9uXG4gICAgLy8gTWFrZSBpdCBzZXF1ZW50aWFsIGZvciBub3csIG5vdCBzdXJlIG9mIHBhcmFsbGVpemF0aW9uIHNpZGUgZWZmZWN0c1xuICAgIGlmIChxdWVyeVsnJG9yJ10pIHtcbiAgICAgIGNvbnN0IG9ycyA9IHF1ZXJ5Wyckb3InXTtcbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgb3JzLm1hcCgoYVF1ZXJ5LCBpbmRleCkgPT4ge1xuICAgICAgICAgIHJldHVybiB0aGlzLnJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lLCBhUXVlcnksIHNjaGVtYSkudGhlbihcbiAgICAgICAgICAgIGFRdWVyeSA9PiB7XG4gICAgICAgICAgICAgIHF1ZXJ5Wyckb3InXVtpbmRleF0gPSBhUXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgKTtcbiAgICAgICAgfSlcbiAgICAgICkudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocXVlcnkpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3QgcHJvbWlzZXMgPSBPYmplY3Qua2V5cyhxdWVyeSkubWFwKGtleSA9PiB7XG4gICAgICBjb25zdCB0ID0gc2NoZW1hLmdldEV4cGVjdGVkVHlwZShjbGFzc05hbWUsIGtleSk7XG4gICAgICBpZiAoIXQgfHwgdC50eXBlICE9PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocXVlcnkpO1xuICAgICAgfVxuICAgICAgbGV0IHF1ZXJpZXM6ID8oYW55W10pID0gbnVsbDtcbiAgICAgIGlmIChcbiAgICAgICAgcXVlcnlba2V5XSAmJlxuICAgICAgICAocXVlcnlba2V5XVsnJGluJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldWyckbmUnXSB8fFxuICAgICAgICAgIHF1ZXJ5W2tleV1bJyRuaW4nXSB8fFxuICAgICAgICAgIHF1ZXJ5W2tleV0uX190eXBlID09ICdQb2ludGVyJylcbiAgICAgICkge1xuICAgICAgICAvLyBCdWlsZCB0aGUgbGlzdCBvZiBxdWVyaWVzXG4gICAgICAgIHF1ZXJpZXMgPSBPYmplY3Qua2V5cyhxdWVyeVtrZXldKS5tYXAoY29uc3RyYWludEtleSA9PiB7XG4gICAgICAgICAgbGV0IHJlbGF0ZWRJZHM7XG4gICAgICAgICAgbGV0IGlzTmVnYXRpb24gPSBmYWxzZTtcbiAgICAgICAgICBpZiAoY29uc3RyYWludEtleSA9PT0gJ29iamVjdElkJykge1xuICAgICAgICAgICAgcmVsYXRlZElkcyA9IFtxdWVyeVtrZXldLm9iamVjdElkXTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGNvbnN0cmFpbnRLZXkgPT0gJyRpbicpIHtcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMgPSBxdWVyeVtrZXldWyckaW4nXS5tYXAociA9PiByLm9iamVjdElkKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGNvbnN0cmFpbnRLZXkgPT0gJyRuaW4nKSB7XG4gICAgICAgICAgICBpc05lZ2F0aW9uID0gdHJ1ZTtcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMgPSBxdWVyeVtrZXldWyckbmluJ10ubWFwKHIgPT4gci5vYmplY3RJZCk7XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckbmUnKSB7XG4gICAgICAgICAgICBpc05lZ2F0aW9uID0gdHJ1ZTtcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMgPSBbcXVlcnlba2V5XVsnJG5lJ10ub2JqZWN0SWRdO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpc05lZ2F0aW9uLFxuICAgICAgICAgICAgcmVsYXRlZElkcyxcbiAgICAgICAgICB9O1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHF1ZXJpZXMgPSBbeyBpc05lZ2F0aW9uOiBmYWxzZSwgcmVsYXRlZElkczogW10gfV07XG4gICAgICB9XG5cbiAgICAgIC8vIHJlbW92ZSB0aGUgY3VycmVudCBxdWVyeUtleSBhcyB3ZSBkb24sdCBuZWVkIGl0IGFueW1vcmVcbiAgICAgIGRlbGV0ZSBxdWVyeVtrZXldO1xuICAgICAgLy8gZXhlY3V0ZSBlYWNoIHF1ZXJ5IGluZGVwZW5kZW50bHkgdG8gYnVpbGQgdGhlIGxpc3Qgb2ZcbiAgICAgIC8vICRpbiAvICRuaW5cbiAgICAgIGNvbnN0IHByb21pc2VzID0gcXVlcmllcy5tYXAocSA9PiB7XG4gICAgICAgIGlmICghcSkge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5vd25pbmdJZHMoY2xhc3NOYW1lLCBrZXksIHEucmVsYXRlZElkcykudGhlbihpZHMgPT4ge1xuICAgICAgICAgIGlmIChxLmlzTmVnYXRpb24pIHtcbiAgICAgICAgICAgIHRoaXMuYWRkTm90SW5PYmplY3RJZHNJZHMoaWRzLCBxdWVyeSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuYWRkSW5PYmplY3RJZHNJZHMoaWRzLCBxdWVyeSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKS50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShxdWVyeSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBNb2RpZmllcyBxdWVyeSBzbyB0aGF0IGl0IG5vIGxvbmdlciBoYXMgJHJlbGF0ZWRUb1xuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gcXVlcnkgaXMgbXV0YXRlZFxuICByZWR1Y2VSZWxhdGlvbktleXMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICBxdWVyeU9wdGlvbnM6IGFueVxuICApOiA/UHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHF1ZXJ5Wyckb3InXSkge1xuICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICBxdWVyeVsnJG9yJ10ubWFwKGFRdWVyeSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKGNsYXNzTmFtZSwgYVF1ZXJ5LCBxdWVyeU9wdGlvbnMpO1xuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9XG5cbiAgICB2YXIgcmVsYXRlZFRvID0gcXVlcnlbJyRyZWxhdGVkVG8nXTtcbiAgICBpZiAocmVsYXRlZFRvKSB7XG4gICAgICByZXR1cm4gdGhpcy5yZWxhdGVkSWRzKFxuICAgICAgICByZWxhdGVkVG8ub2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgcmVsYXRlZFRvLmtleSxcbiAgICAgICAgcmVsYXRlZFRvLm9iamVjdC5vYmplY3RJZCxcbiAgICAgICAgcXVlcnlPcHRpb25zXG4gICAgICApXG4gICAgICAgIC50aGVuKGlkcyA9PiB7XG4gICAgICAgICAgZGVsZXRlIHF1ZXJ5WyckcmVsYXRlZFRvJ107XG4gICAgICAgICAgdGhpcy5hZGRJbk9iamVjdElkc0lkcyhpZHMsIHF1ZXJ5KTtcbiAgICAgICAgICByZXR1cm4gdGhpcy5yZWR1Y2VSZWxhdGlvbktleXMoY2xhc3NOYW1lLCBxdWVyeSwgcXVlcnlPcHRpb25zKTtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oKCkgPT4ge30pO1xuICAgIH1cbiAgfVxuXG4gIGFkZEluT2JqZWN0SWRzSWRzKGlkczogP0FycmF5PHN0cmluZz4gPSBudWxsLCBxdWVyeTogYW55KSB7XG4gICAgY29uc3QgaWRzRnJvbVN0cmluZzogP0FycmF5PHN0cmluZz4gPVxuICAgICAgdHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJyA/IFtxdWVyeS5vYmplY3RJZF0gOiBudWxsO1xuICAgIGNvbnN0IGlkc0Zyb21FcTogP0FycmF5PHN0cmluZz4gPVxuICAgICAgcXVlcnkub2JqZWN0SWQgJiYgcXVlcnkub2JqZWN0SWRbJyRlcSddID8gW3F1ZXJ5Lm9iamVjdElkWyckZXEnXV0gOiBudWxsO1xuICAgIGNvbnN0IGlkc0Zyb21JbjogP0FycmF5PHN0cmluZz4gPVxuICAgICAgcXVlcnkub2JqZWN0SWQgJiYgcXVlcnkub2JqZWN0SWRbJyRpbiddID8gcXVlcnkub2JqZWN0SWRbJyRpbiddIDogbnVsbDtcblxuICAgIC8vIEBmbG93LWRpc2FibGUtbmV4dFxuICAgIGNvbnN0IGFsbElkczogQXJyYXk8QXJyYXk8c3RyaW5nPj4gPSBbXG4gICAgICBpZHNGcm9tU3RyaW5nLFxuICAgICAgaWRzRnJvbUVxLFxuICAgICAgaWRzRnJvbUluLFxuICAgICAgaWRzLFxuICAgIF0uZmlsdGVyKGxpc3QgPT4gbGlzdCAhPT0gbnVsbCk7XG4gICAgY29uc3QgdG90YWxMZW5ndGggPSBhbGxJZHMucmVkdWNlKChtZW1vLCBsaXN0KSA9PiBtZW1vICsgbGlzdC5sZW5ndGgsIDApO1xuXG4gICAgbGV0IGlkc0ludGVyc2VjdGlvbiA9IFtdO1xuICAgIGlmICh0b3RhbExlbmd0aCA+IDEyNSkge1xuICAgICAgaWRzSW50ZXJzZWN0aW9uID0gaW50ZXJzZWN0LmJpZyhhbGxJZHMpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZHNJbnRlcnNlY3Rpb24gPSBpbnRlcnNlY3QoYWxsSWRzKTtcbiAgICB9XG5cbiAgICAvLyBOZWVkIHRvIG1ha2Ugc3VyZSB3ZSBkb24ndCBjbG9iYmVyIGV4aXN0aW5nIHNob3J0aGFuZCAkZXEgY29uc3RyYWludHMgb24gb2JqZWN0SWQuXG4gICAgaWYgKCEoJ29iamVjdElkJyBpbiBxdWVyeSkpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0ge1xuICAgICAgICAkaW46IHVuZGVmaW5lZCxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcXVlcnkub2JqZWN0SWQgPT09ICdzdHJpbmcnKSB7XG4gICAgICBxdWVyeS5vYmplY3RJZCA9IHtcbiAgICAgICAgJGluOiB1bmRlZmluZWQsXG4gICAgICAgICRlcTogcXVlcnkub2JqZWN0SWQsXG4gICAgICB9O1xuICAgIH1cbiAgICBxdWVyeS5vYmplY3RJZFsnJGluJ10gPSBpZHNJbnRlcnNlY3Rpb247XG5cbiAgICByZXR1cm4gcXVlcnk7XG4gIH1cblxuICBhZGROb3RJbk9iamVjdElkc0lkcyhpZHM6IHN0cmluZ1tdID0gW10sIHF1ZXJ5OiBhbnkpIHtcbiAgICBjb25zdCBpZHNGcm9tTmluID1cbiAgICAgIHF1ZXJ5Lm9iamVjdElkICYmIHF1ZXJ5Lm9iamVjdElkWyckbmluJ10gPyBxdWVyeS5vYmplY3RJZFsnJG5pbiddIDogW107XG4gICAgbGV0IGFsbElkcyA9IFsuLi5pZHNGcm9tTmluLCAuLi5pZHNdLmZpbHRlcihsaXN0ID0+IGxpc3QgIT09IG51bGwpO1xuXG4gICAgLy8gbWFrZSBhIHNldCBhbmQgc3ByZWFkIHRvIHJlbW92ZSBkdXBsaWNhdGVzXG4gICAgYWxsSWRzID0gWy4uLm5ldyBTZXQoYWxsSWRzKV07XG5cbiAgICAvLyBOZWVkIHRvIG1ha2Ugc3VyZSB3ZSBkb24ndCBjbG9iYmVyIGV4aXN0aW5nIHNob3J0aGFuZCAkZXEgY29uc3RyYWludHMgb24gb2JqZWN0SWQuXG4gICAgaWYgKCEoJ29iamVjdElkJyBpbiBxdWVyeSkpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0ge1xuICAgICAgICAkbmluOiB1bmRlZmluZWQsXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnkub2JqZWN0SWQgPSB7XG4gICAgICAgICRuaW46IHVuZGVmaW5lZCxcbiAgICAgICAgJGVxOiBxdWVyeS5vYmplY3RJZCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcXVlcnkub2JqZWN0SWRbJyRuaW4nXSA9IGFsbElkcztcbiAgICByZXR1cm4gcXVlcnk7XG4gIH1cblxuICAvLyBSdW5zIGEgcXVlcnkgb24gdGhlIGRhdGFiYXNlLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGEgbGlzdCBvZiBpdGVtcy5cbiAgLy8gT3B0aW9uczpcbiAgLy8gICBza2lwICAgIG51bWJlciBvZiByZXN1bHRzIHRvIHNraXAuXG4gIC8vICAgbGltaXQgICBsaW1pdCB0byB0aGlzIG51bWJlciBvZiByZXN1bHRzLlxuICAvLyAgIHNvcnQgICAgYW4gb2JqZWN0IHdoZXJlIGtleXMgYXJlIHRoZSBmaWVsZHMgdG8gc29ydCBieS5cbiAgLy8gICAgICAgICAgIHRoZSB2YWx1ZSBpcyArMSBmb3IgYXNjZW5kaW5nLCAtMSBmb3IgZGVzY2VuZGluZy5cbiAgLy8gICBjb3VudCAgIHJ1biBhIGNvdW50IGluc3RlYWQgb2YgcmV0dXJuaW5nIHJlc3VsdHMuXG4gIC8vICAgYWNsICAgICByZXN0cmljdCB0aGlzIG9wZXJhdGlvbiB3aXRoIGFuIEFDTCBmb3IgdGhlIHByb3ZpZGVkIGFycmF5XG4gIC8vICAgICAgICAgICBvZiB1c2VyIG9iamVjdElkcyBhbmQgcm9sZXMuIGFjbDogbnVsbCBtZWFucyBubyB1c2VyLlxuICAvLyAgICAgICAgICAgd2hlbiB0aGlzIGZpZWxkIGlzIG5vdCBwcmVzZW50LCBkb24ndCBkbyBhbnl0aGluZyByZWdhcmRpbmcgQUNMcy5cbiAgLy8gVE9ETzogbWFrZSB1c2VySWRzIG5vdCBuZWVkZWQgaGVyZS4gVGhlIGRiIGFkYXB0ZXIgc2hvdWxkbid0IGtub3dcbiAgLy8gYW55dGhpbmcgYWJvdXQgdXNlcnMsIGlkZWFsbHkuIFRoZW4sIGltcHJvdmUgdGhlIGZvcm1hdCBvZiB0aGUgQUNMXG4gIC8vIGFyZyB0byB3b3JrIGxpa2UgdGhlIG90aGVycy5cbiAgZmluZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIGFjbCxcbiAgICAgIHNvcnQgPSB7fSxcbiAgICAgIGNvdW50LFxuICAgICAga2V5cyxcbiAgICAgIG9wLFxuICAgICAgZGlzdGluY3QsXG4gICAgICBwaXBlbGluZSxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgIH06IGFueSA9IHt9LFxuICAgIGF1dGg6IGFueSA9IHt9LFxuICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY2xHcm91cCA9IGFjbCB8fCBbXTtcblxuICAgIG9wID1cbiAgICAgIG9wIHx8XG4gICAgICAodHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09ICdzdHJpbmcnICYmIE9iamVjdC5rZXlzKHF1ZXJ5KS5sZW5ndGggPT09IDFcbiAgICAgICAgPyAnZ2V0J1xuICAgICAgICA6ICdmaW5kJyk7XG4gICAgLy8gQ291bnQgb3BlcmF0aW9uIGlmIGNvdW50aW5nXG4gICAgb3AgPSBjb3VudCA9PT0gdHJ1ZSA/ICdjb3VudCcgOiBvcDtcblxuICAgIGxldCBjbGFzc0V4aXN0cyA9IHRydWU7XG4gICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICdsb2FkU2NoZW1hJyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcilcbiAgICApLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICAvL0FsbG93IHZvbGF0aWxlIGNsYXNzZXMgaWYgcXVlcnlpbmcgd2l0aCBNYXN0ZXIgKGZvciBfUHVzaFN0YXR1cylcbiAgICAgIC8vVE9ETzogTW92ZSB2b2xhdGlsZSBjbGFzc2VzIGNvbmNlcHQgaW50byBtb25nbyBhZGFwdGVyLCBwb3N0Z3JlcyBhZGFwdGVyIHNob3VsZG4ndCBjYXJlXG4gICAgICAvL3RoYXQgYXBpLnBhcnNlLmNvbSBicmVha3Mgd2hlbiBfUHVzaFN0YXR1cyBleGlzdHMgaW4gbW9uZ28uXG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnZ2V0T25lU2NoZW1hJyxcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIGlzTWFzdGVyKVxuICAgICAgKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIC8vIEJlaGF2aW9yIGZvciBub24tZXhpc3RlbnQgY2xhc3NlcyBpcyBraW5kYSB3ZWlyZCBvbiBQYXJzZS5jb20uIFByb2JhYmx5IGRvZXNuJ3QgbWF0dGVyIHRvbyBtdWNoLlxuICAgICAgICAgIC8vIEZvciBub3csIHByZXRlbmQgdGhlIGNsYXNzIGV4aXN0cyBidXQgaGFzIG5vIG9iamVjdHMsXG4gICAgICAgICAgaWYgKGVycm9yID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGNsYXNzRXhpc3RzID0gZmFsc2U7XG4gICAgICAgICAgICByZXR1cm4geyBmaWVsZHM6IHt9IH07XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgICAgIC8vIFBhcnNlLmNvbSB0cmVhdHMgcXVlcmllcyBvbiBfY3JlYXRlZF9hdCBhbmQgX3VwZGF0ZWRfYXQgYXMgaWYgdGhleSB3ZXJlIHF1ZXJpZXMgb24gY3JlYXRlZEF0IGFuZCB1cGRhdGVkQXQsXG4gICAgICAgICAgLy8gc28gZHVwbGljYXRlIHRoYXQgYmVoYXZpb3IgaGVyZS4gSWYgYm90aCBhcmUgc3BlY2lmaWVkLCB0aGUgY29ycmVjdCBiZWhhdmlvciB0byBtYXRjaCBQYXJzZS5jb20gaXMgdG9cbiAgICAgICAgICAvLyB1c2UgdGhlIG9uZSB0aGF0IGFwcGVhcnMgZmlyc3QgaW4gdGhlIHNvcnQgbGlzdC5cbiAgICAgICAgICBpZiAoc29ydC5fY3JlYXRlZF9hdCkge1xuICAgICAgICAgICAgc29ydC5jcmVhdGVkQXQgPSBzb3J0Ll9jcmVhdGVkX2F0O1xuICAgICAgICAgICAgZGVsZXRlIHNvcnQuX2NyZWF0ZWRfYXQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChzb3J0Ll91cGRhdGVkX2F0KSB7XG4gICAgICAgICAgICBzb3J0LnVwZGF0ZWRBdCA9IHNvcnQuX3VwZGF0ZWRfYXQ7XG4gICAgICAgICAgICBkZWxldGUgc29ydC5fdXBkYXRlZF9hdDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgcXVlcnlPcHRpb25zID0geyBza2lwLCBsaW1pdCwgc29ydCwga2V5cywgcmVhZFByZWZlcmVuY2UgfTtcbiAgICAgICAgICBPYmplY3Qua2V5cyhzb3J0KS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lLm1hdGNoKC9eYXV0aERhdGFcXC4oW2EtekEtWjAtOV9dKylcXC5pZCQvKSkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICAgICAgICAgICBgQ2Fubm90IHNvcnQgYnkgJHtmaWVsZE5hbWV9YFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgcm9vdEZpZWxkTmFtZSA9IGdldFJvb3RGaWVsZE5hbWUoZmllbGROYW1lKTtcbiAgICAgICAgICAgIGlmICghU2NoZW1hQ29udHJvbGxlci5maWVsZE5hbWVJc1ZhbGlkKHJvb3RGaWVsZE5hbWUpKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgIGBJbnZhbGlkIGZpZWxkIG5hbWU6ICR7ZmllbGROYW1lfS5gXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgICAgPyBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgICAgICAgOiB0cmFjZVByb21pc2UoXG4gICAgICAgICAgICAgICd2YWxpZGF0ZVBlcm1pc3Npb24nLFxuICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsIG9wKVxuICAgICAgICAgICAgKVxuICAgICAgICAgIClcbiAgICAgICAgICAgIC50aGVuKCgpID0+XG4gICAgICAgICAgICAgIHRyYWNlUHJvbWlzZShcbiAgICAgICAgICAgICAgICAncmVkdWNlUmVsYXRpb25LZXlzJyxcbiAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgdGhpcy5yZWR1Y2VSZWxhdGlvbktleXMoY2xhc3NOYW1lLCBxdWVyeSwgcXVlcnlPcHRpb25zKVxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PlxuICAgICAgICAgICAgICB0cmFjZVByb21pc2UoXG4gICAgICAgICAgICAgICAgJ3JlZHVjZUluUmVsYXRpb24nLFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICB0aGlzLnJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hQ29udHJvbGxlcilcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICBsZXQgcHJvdGVjdGVkRmllbGRzO1xuICAgICAgICAgICAgICBpZiAoIWlzTWFzdGVyKSB7XG4gICAgICAgICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgYWNsR3JvdXBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIC8qIERvbid0IHVzZSBwcm9qZWN0aW9ucyB0byBvcHRpbWl6ZSB0aGUgcHJvdGVjdGVkRmllbGRzIHNpbmNlIHRoZSBwcm90ZWN0ZWRGaWVsZHNcbiAgICAgICAgICAgICAgICAgIGJhc2VkIG9uIHBvaW50ZXItcGVybWlzc2lvbnMgYXJlIGRldGVybWluZWQgYWZ0ZXIgcXVlcnlpbmcuIFRoZSBmaWx0ZXJpbmcgY2FuXG4gICAgICAgICAgICAgICAgICBvdmVyd3JpdGUgdGhlIHByb3RlY3RlZCBmaWVsZHMuICovXG4gICAgICAgICAgICAgICAgcHJvdGVjdGVkRmllbGRzID0gdGhpcy5hZGRQcm90ZWN0ZWRGaWVsZHMoXG4gICAgICAgICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgICAgICAgICAgIGF1dGhcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgICAgICBpZiAob3AgPT09ICdnZXQnKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgICAgIGlmIChvcCA9PT0gJ3VwZGF0ZScgfHwgb3AgPT09ICdkZWxldGUnKSB7XG4gICAgICAgICAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2xHcm91cCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5ID0gYWRkUmVhZEFDTChxdWVyeSwgYWNsR3JvdXApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB2YWxpZGF0ZVF1ZXJ5KHF1ZXJ5LCB0aGlzLnNraXBNb25nb0RCU2VydmVyMTM3MzJXb3JrYXJvdW5kKTtcbiAgICAgICAgICAgICAgaWYgKGNvdW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIDA7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuY291bnQoXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2UgaWYgKGRpc3RpbmN0KSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmRpc3RpbmN0KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIGRpc3RpbmN0XG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBlbHNlIGlmIChwaXBlbGluZSkge1xuICAgICAgICAgICAgICAgIGlmICghY2xhc3NFeGlzdHMpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5hZ2dyZWdhdGUoXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICBwaXBlbGluZSxcbiAgICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgICAgICAgICAgICAgIC5maW5kKGNsYXNzTmFtZSwgc2NoZW1hLCBxdWVyeSwgcXVlcnlPcHRpb25zKVxuICAgICAgICAgICAgICAgICAgLnRoZW4ob2JqZWN0cyA9PlxuICAgICAgICAgICAgICAgICAgICBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIG9iamVjdCA9IHVudHJhbnNmb3JtT2JqZWN0QUNMKG9iamVjdCk7XG4gICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZpbHRlclNlbnNpdGl2ZURhdGEoXG4gICAgICAgICAgICAgICAgICAgICAgICBpc01hc3RlcixcbiAgICAgICAgICAgICAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9wLFxuICAgICAgICAgICAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb3RlY3RlZEZpZWxkcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdFxuICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICAgICAgICAgICAgIGVycm9yXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgZGVsZXRlU2NoZW1hKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYSh7IGNsZWFyQ2FjaGU6IHRydWUgfSlcbiAgICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEoY2xhc3NOYW1lLCB0cnVlKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgcmV0dXJuIHsgZmllbGRzOiB7fSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLnRoZW4oKHNjaGVtYTogYW55KSA9PiB7XG4gICAgICAgIHJldHVybiB0aGlzLmNvbGxlY3Rpb25FeGlzdHMoY2xhc3NOYW1lKVxuICAgICAgICAgIC50aGVuKCgpID0+XG4gICAgICAgICAgICB0aGlzLmFkYXB0ZXIuY291bnQoY2xhc3NOYW1lLCB7IGZpZWxkczoge30gfSwgbnVsbCwgJycsIGZhbHNlKVxuICAgICAgICAgIClcbiAgICAgICAgICAudGhlbihjb3VudCA9PiB7XG4gICAgICAgICAgICBpZiAoY291bnQgPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAyNTUsXG4gICAgICAgICAgICAgICAgYENsYXNzICR7Y2xhc3NOYW1lfSBpcyBub3QgZW1wdHksIGNvbnRhaW5zICR7Y291bnR9IG9iamVjdHMsIGNhbm5vdCBkcm9wIHNjaGVtYS5gXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmRlbGV0ZUNsYXNzKGNsYXNzTmFtZSk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbih3YXNQYXJzZUNvbGxlY3Rpb24gPT4ge1xuICAgICAgICAgICAgaWYgKHdhc1BhcnNlQ29sbGVjdGlvbikge1xuICAgICAgICAgICAgICBjb25zdCByZWxhdGlvbkZpZWxkTmFtZXMgPSBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5maWx0ZXIoXG4gICAgICAgICAgICAgICAgZmllbGROYW1lID0+IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUmVsYXRpb24nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgICAgICAgICByZWxhdGlvbkZpZWxkTmFtZXMubWFwKG5hbWUgPT5cbiAgICAgICAgICAgICAgICAgIHRoaXMuYWRhcHRlci5kZWxldGVDbGFzcyhqb2luVGFibGVOYW1lKGNsYXNzTmFtZSwgbmFtZSkpXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICBzY2hlbWE6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlcixcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvcGVyYXRpb246IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIGFjbEdyb3VwOiBhbnlbXSA9IFtdXG4gICkge1xuICAgIC8vIENoZWNrIGlmIGNsYXNzIGhhcyBwdWJsaWMgcGVybWlzc2lvbiBmb3Igb3BlcmF0aW9uXG4gICAgLy8gSWYgdGhlIEJhc2VDTFAgcGFzcywgbGV0IGdvIHRocm91Z2hcbiAgICBpZiAoc2NoZW1hLnRlc3RQZXJtaXNzaW9uc0ZvckNsYXNzTmFtZShjbGFzc05hbWUsIGFjbEdyb3VwLCBvcGVyYXRpb24pKSB7XG4gICAgICByZXR1cm4gcXVlcnk7XG4gICAgfVxuICAgIGNvbnN0IHBlcm1zID0gc2NoZW1hLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWUpO1xuICAgIGNvbnN0IGZpZWxkID1cbiAgICAgIFsnZ2V0JywgJ2ZpbmQnXS5pbmRleE9mKG9wZXJhdGlvbikgPiAtMVxuICAgICAgICA/ICdyZWFkVXNlckZpZWxkcydcbiAgICAgICAgOiAnd3JpdGVVc2VyRmllbGRzJztcbiAgICBjb25zdCB1c2VyQUNMID0gYWNsR3JvdXAuZmlsdGVyKGFjbCA9PiB7XG4gICAgICByZXR1cm4gYWNsLmluZGV4T2YoJ3JvbGU6JykgIT0gMCAmJiBhY2wgIT0gJyonO1xuICAgIH0pO1xuICAgIC8vIHRoZSBBQ0wgc2hvdWxkIGhhdmUgZXhhY3RseSAxIHVzZXJcbiAgICBpZiAocGVybXMgJiYgcGVybXNbZmllbGRdICYmIHBlcm1zW2ZpZWxkXS5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBObyB1c2VyIHNldCByZXR1cm4gdW5kZWZpbmVkXG4gICAgICAvLyBJZiB0aGUgbGVuZ3RoIGlzID4gMSwgdGhhdCBtZWFucyB3ZSBkaWRuJ3QgZGUtZHVwZSB1c2VycyBjb3JyZWN0bHlcbiAgICAgIGlmICh1c2VyQUNMLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHVzZXJJZCA9IHVzZXJBQ0xbMF07XG4gICAgICBjb25zdCB1c2VyUG9pbnRlciA9IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHVzZXJJZCxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHBlcm1GaWVsZHMgPSBwZXJtc1tmaWVsZF07XG4gICAgICBjb25zdCBvcnMgPSBwZXJtRmllbGRzLmZsYXRNYXAoa2V5ID0+IHtcbiAgICAgICAgLy8gY29uc3RyYWludCBmb3Igc2luZ2xlIHBvaW50ZXIgc2V0dXBcbiAgICAgICAgY29uc3QgcSA9IHtcbiAgICAgICAgICBba2V5XTogdXNlclBvaW50ZXIsXG4gICAgICAgIH07XG4gICAgICAgIC8vIGNvbnN0cmFpbnQgZm9yIHVzZXJzLWFycmF5IHNldHVwXG4gICAgICAgIGNvbnN0IHFhID0ge1xuICAgICAgICAgIFtrZXldOiB7ICRhbGw6IFt1c2VyUG9pbnRlcl0gfSxcbiAgICAgICAgfTtcbiAgICAgICAgLy8gaWYgd2UgYWxyZWFkeSBoYXZlIGEgY29uc3RyYWludCBvbiB0aGUga2V5LCB1c2UgdGhlICRhbmRcbiAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChxdWVyeSwga2V5KSkge1xuICAgICAgICAgIHJldHVybiBbeyAkYW5kOiBbcSwgcXVlcnldIH0sIHsgJGFuZDogW3FhLCBxdWVyeV0gfV07XG4gICAgICAgIH1cbiAgICAgICAgLy8gb3RoZXJ3aXNlIGp1c3QgYWRkIHRoZSBjb25zdGFpbnRcbiAgICAgICAgcmV0dXJuIFtPYmplY3QuYXNzaWduKHt9LCBxdWVyeSwgcSksIE9iamVjdC5hc3NpZ24oe30sIHF1ZXJ5LCBxYSldO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4geyAkb3I6IG9ycyB9O1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gcXVlcnk7XG4gICAgfVxuICB9XG5cbiAgYWRkUHJvdGVjdGVkRmllbGRzKFxuICAgIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHF1ZXJ5OiBhbnkgPSB7fSxcbiAgICBhY2xHcm91cDogYW55W10gPSBbXSxcbiAgICBhdXRoOiBhbnkgPSB7fVxuICApIHtcbiAgICBjb25zdCBwZXJtcyA9IHNjaGVtYS5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lKTtcbiAgICBpZiAoIXBlcm1zKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IHByb3RlY3RlZEZpZWxkcyA9IHBlcm1zLnByb3RlY3RlZEZpZWxkcztcbiAgICBpZiAoIXByb3RlY3RlZEZpZWxkcykgcmV0dXJuIG51bGw7XG5cbiAgICBpZiAoYWNsR3JvdXAuaW5kZXhPZihxdWVyeS5vYmplY3RJZCkgPiAtMSkgcmV0dXJuIG51bGw7XG5cbiAgICAvLyByZW1vdmUgdXNlckZpZWxkIGtleXMgc2luY2UgdGhleSBhcmUgZmlsdGVyZWQgYWZ0ZXIgcXVlcnlpbmdcbiAgICBsZXQgcHJvdGVjdGVkS2V5cyA9IE9iamVjdC5rZXlzKHByb3RlY3RlZEZpZWxkcykucmVkdWNlKChhY2MsIHZhbCkgPT4ge1xuICAgICAgaWYgKHZhbC5zdGFydHNXaXRoKCd1c2VyRmllbGQ6JykpIHJldHVybiBhY2M7XG4gICAgICByZXR1cm4gYWNjLmNvbmNhdChwcm90ZWN0ZWRGaWVsZHNbdmFsXSk7XG4gICAgfSwgW10pO1xuXG4gICAgWy4uLihhdXRoLnVzZXJSb2xlcyB8fCBbXSldLmZvckVhY2gocm9sZSA9PiB7XG4gICAgICBjb25zdCBmaWVsZHMgPSBwcm90ZWN0ZWRGaWVsZHNbcm9sZV07XG4gICAgICBpZiAoZmllbGRzKSB7XG4gICAgICAgIHByb3RlY3RlZEtleXMgPSBwcm90ZWN0ZWRLZXlzLmZpbHRlcih2ID0+IGZpZWxkcy5pbmNsdWRlcyh2KSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gcHJvdGVjdGVkS2V5cztcbiAgfVxuXG4gIGNyZWF0ZVRyYW5zYWN0aW9uYWxTZXNzaW9uKCkge1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5jcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbigpXG4gICAgICAudGhlbih0cmFuc2FjdGlvbmFsU2Vzc2lvbiA9PiB7XG4gICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uID0gdHJhbnNhY3Rpb25hbFNlc3Npb247XG4gICAgICB9KTtcbiAgfVxuXG4gIGNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uKCkge1xuICAgIGlmICghdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignVGhlcmUgaXMgbm8gdHJhbnNhY3Rpb25hbCBzZXNzaW9uIHRvIGNvbW1pdCcpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24odGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uID0gbnVsbDtcbiAgICAgIH0pO1xuICB9XG5cbiAgYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbigpIHtcbiAgICBpZiAoIXRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZXJlIGlzIG5vIHRyYW5zYWN0aW9uYWwgc2Vzc2lvbiB0byBhYm9ydCcpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSBudWxsO1xuICAgICAgfSk7XG4gIH1cblxuICAvLyBUT0RPOiBjcmVhdGUgaW5kZXhlcyBvbiBmaXJzdCBjcmVhdGlvbiBvZiBhIF9Vc2VyIG9iamVjdC4gT3RoZXJ3aXNlIGl0J3MgaW1wb3NzaWJsZSB0b1xuICAvLyBoYXZlIGEgUGFyc2UgYXBwIHdpdGhvdXQgaXQgaGF2aW5nIGEgX1VzZXIgY29sbGVjdGlvbi5cbiAgcGVyZm9ybUluaXRpYWxpemF0aW9uKCkge1xuICAgIGNvbnN0IHJlcXVpcmVkVXNlckZpZWxkcyA9IHtcbiAgICAgIGZpZWxkczoge1xuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9EZWZhdWx0LFxuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9Vc2VyLFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlcXVpcmVkUm9sZUZpZWxkcyA9IHtcbiAgICAgIGZpZWxkczoge1xuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9EZWZhdWx0LFxuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9Sb2xlLFxuICAgICAgfSxcbiAgICB9O1xuXG4gICAgY29uc3QgdXNlckNsYXNzUHJvbWlzZSA9IHRoaXMubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hID0+XG4gICAgICBzY2hlbWEuZW5mb3JjZUNsYXNzRXhpc3RzKCdfVXNlcicpXG4gICAgKTtcbiAgICBjb25zdCByb2xlQ2xhc3NQcm9taXNlID0gdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT5cbiAgICAgIHNjaGVtYS5lbmZvcmNlQ2xhc3NFeGlzdHMoJ19Sb2xlJylcbiAgICApO1xuXG4gICAgY29uc3QgdXNlcm5hbWVVbmlxdWVuZXNzID0gdXNlckNsYXNzUHJvbWlzZVxuICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgdGhpcy5hZGFwdGVyLmVuc3VyZVVuaXF1ZW5lc3MoJ19Vc2VyJywgcmVxdWlyZWRVc2VyRmllbGRzLCBbJ3VzZXJuYW1lJ10pXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBsb2dnZXIud2FybignVW5hYmxlIHRvIGVuc3VyZSB1bmlxdWVuZXNzIGZvciB1c2VybmFtZXM6ICcsIGVycm9yKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcblxuICAgIGNvbnN0IGVtYWlsVW5pcXVlbmVzcyA9IHVzZXJDbGFzc1Byb21pc2VcbiAgICAgIC50aGVuKCgpID0+XG4gICAgICAgIHRoaXMuYWRhcHRlci5lbnN1cmVVbmlxdWVuZXNzKCdfVXNlcicsIHJlcXVpcmVkVXNlckZpZWxkcywgWydlbWFpbCddKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgICAgJ1VuYWJsZSB0byBlbnN1cmUgdW5pcXVlbmVzcyBmb3IgdXNlciBlbWFpbCBhZGRyZXNzZXM6ICcsXG4gICAgICAgICAgZXJyb3JcbiAgICAgICAgKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcblxuICAgIGNvbnN0IHJvbGVVbmlxdWVuZXNzID0gcm9sZUNsYXNzUHJvbWlzZVxuICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgdGhpcy5hZGFwdGVyLmVuc3VyZVVuaXF1ZW5lc3MoJ19Sb2xlJywgcmVxdWlyZWRSb2xlRmllbGRzLCBbJ25hbWUnXSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIHJvbGUgbmFtZTogJywgZXJyb3IpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgaW5kZXhQcm9taXNlID0gdGhpcy5hZGFwdGVyLnVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzKCk7XG5cbiAgICAvLyBDcmVhdGUgdGFibGVzIGZvciB2b2xhdGlsZSBjbGFzc2VzXG4gICAgY29uc3QgYWRhcHRlckluaXQgPSB0aGlzLmFkYXB0ZXIucGVyZm9ybUluaXRpYWxpemF0aW9uKHtcbiAgICAgIFZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXM6IFNjaGVtYUNvbnRyb2xsZXIuVm9sYXRpbGVDbGFzc2VzU2NoZW1hcyxcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgdXNlcm5hbWVVbmlxdWVuZXNzLFxuICAgICAgZW1haWxVbmlxdWVuZXNzLFxuICAgICAgcm9sZVVuaXF1ZW5lc3MsXG4gICAgICBhZGFwdGVySW5pdCxcbiAgICAgIGluZGV4UHJvbWlzZSxcbiAgICBdKTtcbiAgfVxuXG4gIHN0YXRpYyBfdmFsaWRhdGVRdWVyeTogKGFueSwgYm9vbGVhbikgPT4gdm9pZDtcbn1cblxuZnVuY3Rpb24gdHJhY2VQcm9taXNlKG9wZXJhdGlvbiwgY2xhc3NOYW1lLCBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCkpIHtcbiAgY29uc3QgcGFyZW50ID0gQVdTWFJheS5nZXRTZWdtZW50KCk7XG4gIGlmICghcGFyZW50KSB7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBBV1NYUmF5LmNhcHR1cmVBc3luY0Z1bmMoXG4gICAgICBgUGFyc2UtU2VydmVyX0RhdGFiYXNlQ3RybF8ke29wZXJhdGlvbn1fJHtjbGFzc05hbWV9YCxcbiAgICAgIHN1YnNlZ21lbnQgPT4ge1xuICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ29udHJvbGxlcicsICdEYXRhYmFzZUN0cmwnKTtcbiAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ09wZXJhdGlvbicsIG9wZXJhdGlvbik7XG4gICAgICAgIGNsYXNzTmFtZSAmIHN1YnNlZ21lbnQgJiZcbiAgICAgICAgICBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ0NsYXNzTmFtZScsIGNsYXNzTmFtZSk7XG4gICAgICAgIHByb21pc2UudGhlbihcbiAgICAgICAgICBmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgICAgICAgIHJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5jbG9zZSgpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgZnVuY3Rpb24oZXJyb3IpIHtcbiAgICAgICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuY2xvc2UoZXJyb3IpO1xuICAgICAgICAgIH1cbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICApO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBEYXRhYmFzZUNvbnRyb2xsZXI7XG4vLyBFeHBvc2UgdmFsaWRhdGVRdWVyeSBmb3IgdGVzdHNcbm1vZHVsZS5leHBvcnRzLl92YWxpZGF0ZVF1ZXJ5ID0gdmFsaWRhdGVRdWVyeTtcbiJdfQ==