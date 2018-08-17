'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.MongoStorageAdapter = undefined;

var _MongoCollection = require('./MongoCollection');

var _MongoCollection2 = _interopRequireDefault(_MongoCollection);

var _MongoSchemaCollection = require('./MongoSchemaCollection');

var _MongoSchemaCollection2 = _interopRequireDefault(_MongoSchemaCollection);

var _StorageAdapter = require('../StorageAdapter');

var _mongodbUrl = require('../../../vendor/mongodbUrl');

var _MongoTransform = require('./MongoTransform');

var _node = require('parse/node');

var _node2 = _interopRequireDefault(_node);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _defaults = require('../../../defaults');

var _defaults2 = _interopRequireDefault(_defaults);

var _logger = require('../../../logger');

var _logger2 = _interopRequireDefault(_logger);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _objectWithoutProperties(obj, keys) { var target = {}; for (var i in obj) { if (keys.indexOf(i) >= 0) continue; if (!Object.prototype.hasOwnProperty.call(obj, i)) continue; target[i] = obj[i]; } return target; }
// -disable-next

// -disable-next


// -disable-next
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const ReadPreference = mongodb.ReadPreference;

const MongoSchemaCollectionName = '_SCHEMA';

const storageAdapterAllCollections = mongoAdapter => {
  return mongoAdapter.connect().then(() => mongoAdapter.database.collections()).then(collections => {
    return collections.filter(collection => {
      if (collection.namespace.match(/\.system\./)) {
        return false;
      }
      // TODO: If you have one app with a collection prefix that happens to be a prefix of another
      // apps prefix, this will go very very badly. We should fix that somehow.
      return collection.collectionName.indexOf(mongoAdapter._collectionPrefix) == 0;
    });
  });
};

const convertParseSchemaToMongoSchema = (_ref) => {
  let schema = _objectWithoutProperties(_ref, []);

  delete schema.fields._rperm;
  delete schema.fields._wperm;

  if (schema.className === '_User') {
    // Legacy mongo adapter knows about the difference between password and _hashed_password.
    // Future database adapters will only know about _hashed_password.
    // Note: Parse Server will bring back password with injectDefaultSchema, so we don't need
    // to add _hashed_password back ever.
    delete schema.fields._hashed_password;
  }

  return schema;
};

// Returns { code, error } if invalid, or { result }, an object
// suitable for inserting into _SCHEMA collection, otherwise.
const mongoSchemaFromFieldsAndClassNameAndCLP = (fields, className, classLevelPermissions, indexes) => {
  const mongoObject = {
    _id: className,
    objectId: 'string',
    updatedAt: 'string',
    createdAt: 'string',
    _metadata: undefined
  };

  for (const fieldName in fields) {
    mongoObject[fieldName] = _MongoSchemaCollection2.default.parseFieldTypeToMongoFieldType(fields[fieldName]);
  }

  if (typeof classLevelPermissions !== 'undefined') {
    mongoObject._metadata = mongoObject._metadata || {};
    if (!classLevelPermissions) {
      delete mongoObject._metadata.class_permissions;
    } else {
      mongoObject._metadata.class_permissions = classLevelPermissions;
    }
  }

  if (indexes && typeof indexes === 'object' && Object.keys(indexes).length > 0) {
    mongoObject._metadata = mongoObject._metadata || {};
    mongoObject._metadata.indexes = indexes;
  }

  if (!mongoObject._metadata) {
    // cleanup the unused _metadata
    delete mongoObject._metadata;
  }

  return mongoObject;
};

class MongoStorageAdapter {
  // Private
  constructor({
    uri = _defaults2.default.DefaultMongoURI,
    collectionPrefix = '',
    mongoOptions = {}
  }) {
    this._uri = uri;
    this._collectionPrefix = collectionPrefix;
    this._mongoOptions = mongoOptions;

    // MaxTimeMS is not a global MongoDB client option, it is applied per operation.
    this._maxTimeMS = mongoOptions.maxTimeMS;
    this.canSortOnJoinTables = true;
    delete mongoOptions.maxTimeMS;
  }
  // Public


  connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // parsing and re-formatting causes the auth value (if there) to get URI
    // encoded
    const encodedUri = (0, _mongodbUrl.format)((0, _mongodbUrl.parse)(this._uri));

    this.connectionPromise = MongoClient.connect(encodedUri, this._mongoOptions).then(client => {
      // Starting mongoDB 3.0, the MongoClient.connect don't return a DB anymore but a client
      // Fortunately, we can get back the options and use them to select the proper DB.
      // https://github.com/mongodb/node-mongodb-native/blob/2c35d76f08574225b8db02d7bef687123e6bb018/lib/mongo_client.js#L885
      const options = client.s.options;
      const database = client.db(options.dbName);
      if (!database) {
        delete this.connectionPromise;
        return;
      }
      database.on('error', () => {
        delete this.connectionPromise;
      });
      database.on('close', () => {
        delete this.connectionPromise;
      });
      this.client = client;
      this.database = database;
    }).catch(err => {
      delete this.connectionPromise;
      return Promise.reject(err);
    });

    return this.connectionPromise;
  }

  handleError(error) {
    if (error && error.code === 13) {
      // Unauthorized error
      delete this.client;
      delete this.database;
      delete this.connectionPromise;
      _logger2.default.error('Received unauthorized error', { error: error });
    }
    throw error;
  }

  handleShutdown() {
    if (!this.client) {
      return;
    }
    this.client.close(false);
  }

  _adaptiveCollection(name) {
    return this.connect().then(() => this.database.collection(this._collectionPrefix + name)).then(rawCollection => new _MongoCollection2.default(rawCollection)).catch(err => this.handleError(err));
  }

  _schemaCollection() {
    return this.connect().then(() => this._adaptiveCollection(MongoSchemaCollectionName)).then(collection => new _MongoSchemaCollection2.default(collection));
  }

  classExists(name) {
    return this.connect().then(() => {
      return this.database.listCollections({ name: this._collectionPrefix + name }).toArray();
    }).then(collections => {
      return collections.length > 0;
    }).catch(err => this.handleError(err));
  }

  setClassLevelPermissions(className, CLPs) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: { '_metadata.class_permissions': CLPs }
    })).catch(err => this.handleError(err));
  }

  setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields) {
    if (submittedIndexes === undefined) {
      return Promise.resolve();
    }
    if (Object.keys(existingIndexes).length === 0) {
      existingIndexes = { _id_: { _id: 1 } };
    }
    const deletePromises = [];
    const insertedIndexes = [];
    Object.keys(submittedIndexes).forEach(name => {
      const field = submittedIndexes[name];
      if (existingIndexes[name] && field.__op !== 'Delete') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
      }
      if (!existingIndexes[name] && field.__op === 'Delete') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Index ${name} does not exist, cannot delete.`);
      }
      if (field.__op === 'Delete') {
        const promise = this.dropIndex(className, name);
        deletePromises.push(promise);
        delete existingIndexes[name];
      } else {
        Object.keys(field).forEach(key => {
          if (!fields.hasOwnProperty(key)) {
            throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Field ${key} does not exist, cannot add index.`);
          }
        });
        existingIndexes[name] = field;
        insertedIndexes.push({
          key: field,
          name
        });
      }
    });
    let insertPromise = Promise.resolve();
    if (insertedIndexes.length > 0) {
      insertPromise = this.createIndexes(className, insertedIndexes);
    }
    return Promise.all(deletePromises).then(() => insertPromise).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: { '_metadata.indexes': existingIndexes }
    })).catch(err => this.handleError(err));
  }

  setIndexesFromMongo(className) {
    return this.getIndexes(className).then(indexes => {
      indexes = indexes.reduce((obj, index) => {
        if (index.key._fts) {
          delete index.key._fts;
          delete index.key._ftsx;
          for (const field in index.weights) {
            index.key[field] = 'text';
          }
        }
        obj[index.name] = index.key;
        return obj;
      }, {});
      return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
        $set: { '_metadata.indexes': indexes }
      }));
    }).catch(err => this.handleError(err)).catch(() => {
      // Ignore if collection not found
      return Promise.resolve();
    });
  }

  createClass(className, schema) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = mongoSchemaFromFieldsAndClassNameAndCLP(schema.fields, className, schema.classLevelPermissions, schema.indexes);
    mongoObject._id = className;
    return this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.insertSchema(mongoObject)).catch(err => this.handleError(err));
  }

  addFieldIfNotExists(className, fieldName, type) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.addFieldIfNotExists(className, fieldName, type)).then(() => this.createIndexesIfNeeded(className, fieldName, type)).catch(err => this.handleError(err));
  }

  // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.
  deleteClass(className) {
    return this._adaptiveCollection(className).then(collection => collection.drop()).catch(error => {
      // 'ns not found' means collection was already gone. Ignore deletion attempt.
      if (error.message == 'ns not found') {
        return;
      }
      throw error;
    })
    // We've dropped the collection, now remove the _SCHEMA document
    .then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.findAndDeleteSchema(className)).catch(err => this.handleError(err));
  }

  deleteAllClasses(fast) {
    return storageAdapterAllCollections(this).then(collections => Promise.all(collections.map(collection => fast ? collection.remove({}) : collection.drop())));
  }

  // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.

  // Pointer field names are passed for legacy reasons: the original mongo
  // format stored pointer field names differently in the database, and therefore
  // needed to know the type of the field before it could delete it. Future database
  // adapters should ignore the pointerFieldNames argument. All the field names are in
  // fieldNames, they show up additionally in the pointerFieldNames database for use
  // by the mongo adapter, which deals with the legacy mongo format.

  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.

  // Returns a Promise.
  deleteFields(className, schema, fieldNames) {
    const mongoFormatNames = fieldNames.map(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer') {
        return `_p_${fieldName}`;
      } else {
        return fieldName;
      }
    });
    const collectionUpdate = { '$unset': {} };
    mongoFormatNames.forEach(name => {
      collectionUpdate['$unset'][name] = null;
    });

    const schemaUpdate = { '$unset': {} };
    fieldNames.forEach(name => {
      schemaUpdate['$unset'][name] = null;
    });

    return this._adaptiveCollection(className).then(collection => collection.updateMany({}, collectionUpdate)).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, schemaUpdate)).catch(err => this.handleError(err));
  }

  // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.
  getAllClasses() {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchAllSchemasFrom_SCHEMA()).catch(err => this.handleError(err));
  }

  // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.
  getClass(className) {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchOneSchemaFrom_SCHEMA(className)).catch(err => this.handleError(err));
  }

  // TODO: As yet not particularly well specified. Creates an object. Maybe shouldn't even need the schema,
  // and should infer from the type. Or maybe does need the schema for validations. Or maybe needs
  // the schema only for the legacy mongo format. We'll figure that out later.
  createObject(className, schema, object) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, object, schema);
    return this._adaptiveCollection(className).then(collection => collection.insertOne(mongoObject)).catch(error => {
      if (error.code === 11000) {
        // Duplicate value
        const err = new _node2.default.Error(_node2.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);
          if (matches && Array.isArray(matches)) {
            err.userInfo = { duplicated_field: matches[1] };
          }
        }
        throw err;
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.
  deleteObjectsByQuery(className, schema, query) {
    schema = convertParseSchemaToMongoSchema(schema);
    return this._adaptiveCollection(className).then(collection => {
      const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
      return collection.deleteMany(mongoWhere);
    }).catch(err => this.handleError(err)).then(({ result }) => {
      if (result.n === 0) {
        throw new _node2.default.Error(_node2.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }
      return Promise.resolve();
    }, () => {
      throw new _node2.default.Error(_node2.default.Error.INTERNAL_SERVER_ERROR, 'Database adapter error');
    });
  }

  // Apply the update to all objects that match the given Parse Query.
  updateObjectsByQuery(className, schema, query, update) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.updateMany(mongoWhere, mongoUpdate)).catch(err => this.handleError(err));
  }

  // Atomically finds and updates an object based on query.
  // Return value not currently well specified.
  findOneAndUpdate(className, schema, query, update) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.findAndModify(mongoWhere, [], mongoUpdate, { new: true })).then(result => (0, _MongoTransform.mongoObjectToParseObject)(className, result.value, schema)).catch(error => {
      if (error.code === 11000) {
        throw new _node2.default.Error(_node2.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Hopefully we can get rid of this. It's only used for config and hooks.
  upsertOneObject(className, schema, query, update) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.upsertOne(mongoWhere, mongoUpdate)).catch(err => this.handleError(err));
  }

  // Executes a find. Accepts: className, query in Parse format, and { skip, limit, sort }.
  find(className, schema, query, { skip, limit, sort, keys, readPreference }) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    const mongoSort = _lodash2.default.mapKeys(sort, (value, fieldName) => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    const mongoKeys = _lodash2.default.reduce(keys, (memo, key) => {
      if (key === 'ACL') {
        memo['_rperm'] = 1;
        memo['_wperm'] = 1;
      } else {
        memo[(0, _MongoTransform.transformKey)(className, key, schema)] = 1;
      }
      return memo;
    }, {});

    readPreference = this._parseReadPreference(readPreference);
    return this.createTextIndexesIfNeeded(className, query, schema).then(() => this._adaptiveCollection(className)).then(collection => collection.find(mongoWhere, {
      skip,
      limit,
      sort: mongoSort,
      keys: mongoKeys,
      maxTimeMS: this._maxTimeMS,
      readPreference
    })).then(objects => objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema))).catch(err => this.handleError(err));
  }

  // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.
  ensureUniqueness(className, schema, fieldNames) {
    schema = convertParseSchemaToMongoSchema(schema);
    const indexCreationRequest = {};
    const mongoFieldNames = fieldNames.map(fieldName => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    mongoFieldNames.forEach(fieldName => {
      indexCreationRequest[fieldName] = 1;
    });
    return this._adaptiveCollection(className).then(collection => collection._ensureSparseUniqueIndexInBackground(indexCreationRequest)).catch(error => {
      if (error.code === 11000) {
        throw new _node2.default.Error(_node2.default.Error.DUPLICATE_VALUE, 'Tried to ensure field uniqueness for a class that already has duplicates.');
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Used in tests
  _rawFind(className, query) {
    return this._adaptiveCollection(className).then(collection => collection.find(query, {
      maxTimeMS: this._maxTimeMS
    })).catch(err => this.handleError(err));
  }

  // Executes a count.
  count(className, schema, query, readPreference) {
    schema = convertParseSchemaToMongoSchema(schema);
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.count((0, _MongoTransform.transformWhere)(className, query, schema), {
      maxTimeMS: this._maxTimeMS,
      readPreference
    })).catch(err => this.handleError(err));
  }

  distinct(className, schema, query, fieldName) {
    schema = convertParseSchemaToMongoSchema(schema);
    const isPointerField = schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    if (isPointerField) {
      fieldName = `_p_${fieldName}`;
    }
    return this._adaptiveCollection(className).then(collection => collection.distinct(fieldName, (0, _MongoTransform.transformWhere)(className, query, schema))).then(objects => {
      objects = objects.filter(obj => obj != null);
      return objects.map(object => {
        if (isPointerField) {
          const field = fieldName.substring(3);
          return (0, _MongoTransform.transformPointerString)(schema, field, object);
        }
        return (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema);
      });
    }).catch(err => this.handleError(err));
  }

  aggregate(className, schema, pipeline, readPreference) {
    let isPointerField = false;
    pipeline = pipeline.map(stage => {
      if (stage.$group) {
        stage.$group = this._parseAggregateGroupArgs(schema, stage.$group);
        if (stage.$group._id && typeof stage.$group._id === 'string' && stage.$group._id.indexOf('$_p_') >= 0) {
          isPointerField = true;
        }
      }
      if (stage.$match) {
        stage.$match = this._parseAggregateArgs(schema, stage.$match);
      }
      if (stage.$project) {
        stage.$project = this._parseAggregateProjectArgs(schema, stage.$project);
      }
      return stage;
    });
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.aggregate(pipeline, { readPreference, maxTimeMS: this._maxTimeMS })).catch(error => {
      if (error.code === 16006) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, error.message);
      }
      throw error;
    }).then(results => {
      results.forEach(result => {
        if (result.hasOwnProperty('_id')) {
          if (isPointerField && result._id) {
            result._id = result._id.split('$')[1];
          }
          if (result._id == null || _lodash2.default.isEmpty(result._id)) {
            result._id = null;
          }
          result.objectId = result._id;
          delete result._id;
        }
      });
      return results;
    }).then(objects => objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema))).catch(err => this.handleError(err));
  }

  // This function will recursively traverse the pipeline and convert any Pointer or Date columns.
  // If we detect a pointer column we will rename the column being queried for to match the column
  // in the database. We also modify the value to what we expect the value to be in the database
  // as well.
  // For dates, the driver expects a Date object, but we have a string coming in. So we'll convert
  // the string to a Date so the driver can perform the necessary comparison.
  //
  // The goal of this method is to look for the "leaves" of the pipeline and determine if it needs
  // to be converted. The pipeline can have a few different forms. For more details, see:
  //     https://docs.mongodb.com/manual/reference/operator/aggregation/
  //
  // If the pipeline is an array, it means we are probably parsing an '$and' or '$or' operator. In
  // that case we need to loop through all of it's children to find the columns being operated on.
  // If the pipeline is an object, then we'll loop through the keys checking to see if the key name
  // matches one of the schema columns. If it does match a column and the column is a Pointer or
  // a Date, then we'll convert the value as described above.
  //
  // As much as I hate recursion...this seemed like a good fit for it. We're essentially traversing
  // down a tree to find a "leaf node" and checking to see if it needs to be converted.
  _parseAggregateArgs(schema, pipeline) {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateArgs(schema, value));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};
      for (const field in pipeline) {
        if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
          if (typeof pipeline[field] === 'object') {
            // Pass objects down to MongoDB...this is more than likely an $exists operator.
            returnValue[`_p_${field}`] = pipeline[field];
          } else {
            returnValue[`_p_${field}`] = `${schema.fields[field].targetClass}$${pipeline[field]}`;
          }
        } else if (schema.fields[field] && schema.fields[field].type === 'Date') {
          returnValue[field] = this._convertToDate(pipeline[field]);
        } else {
          returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
        }

        if (field === 'objectId') {
          returnValue['_id'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'createdAt') {
          returnValue['_created_at'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'updatedAt') {
          returnValue['_updated_at'] = returnValue[field];
          delete returnValue[field];
        }
      }
      return returnValue;
    }
    return pipeline;
  }

  // This function is slightly different than the one above. Rather than trying to combine these
  // two functions and making the code even harder to understand, I decided to split it up. The
  // difference with this function is we are not transforming the values, only the keys of the
  // pipeline.
  _parseAggregateProjectArgs(schema, pipeline) {
    const returnValue = {};
    for (const field in pipeline) {
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        returnValue[`_p_${field}`] = pipeline[field];
      } else {
        returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
      }

      if (field === 'objectId') {
        returnValue['_id'] = returnValue[field];
        delete returnValue[field];
      } else if (field === 'createdAt') {
        returnValue['_created_at'] = returnValue[field];
        delete returnValue[field];
      } else if (field === 'updatedAt') {
        returnValue['_updated_at'] = returnValue[field];
        delete returnValue[field];
      }
    }
    return returnValue;
  }

  // This function is slightly different than the two above. MongoDB $group aggregate looks like:
  //     { $group: { _id: <expression>, <field1>: { <accumulator1> : <expression1> }, ... } }
  // The <expression> could be a column name, prefixed with the '$' character. We'll look for
  // these <expression> and check to see if it is a 'Pointer' or if it's one of createdAt,
  // updatedAt or objectId and change it accordingly.
  _parseAggregateGroupArgs(schema, pipeline) {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateGroupArgs(schema, value));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};
      for (const field in pipeline) {
        returnValue[field] = this._parseAggregateGroupArgs(schema, pipeline[field]);
      }
      return returnValue;
    } else if (typeof pipeline === 'string') {
      const field = pipeline.substring(1);
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        return `$_p_${field}`;
      } else if (field == 'createdAt') {
        return '$_created_at';
      } else if (field == 'updatedAt') {
        return '$_updated_at';
      }
    }
    return pipeline;
  }

  // This function will attempt to convert the provided value to a Date object. Since this is part
  // of an aggregation pipeline, the value can either be a string or it can be another object with
  // an operator in it (like $gt, $lt, etc). Because of this I felt it was easier to make this a
  // recursive method to traverse down to the "leaf node" which is going to be the string.
  _convertToDate(value) {
    if (typeof value === 'string') {
      return new Date(value);
    }

    const returnValue = {};
    for (const field in value) {
      returnValue[field] = this._convertToDate(value[field]);
    }
    return returnValue;
  }

  _parseReadPreference(readPreference) {
    switch (readPreference) {
      case 'PRIMARY':
        readPreference = ReadPreference.PRIMARY;
        break;
      case 'PRIMARY_PREFERRED':
        readPreference = ReadPreference.PRIMARY_PREFERRED;
        break;
      case 'SECONDARY':
        readPreference = ReadPreference.SECONDARY;
        break;
      case 'SECONDARY_PREFERRED':
        readPreference = ReadPreference.SECONDARY_PREFERRED;
        break;
      case 'NEAREST':
        readPreference = ReadPreference.NEAREST;
        break;
      case undefined:
        break;
      default:
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, 'Not supported read preference.');
    }
    return readPreference;
  }

  performInitialization() {
    return Promise.resolve();
  }

  createIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndex(index)).catch(err => this.handleError(err));
  }

  createIndexes(className, indexes) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndexes(indexes)).catch(err => this.handleError(err));
  }

  createIndexesIfNeeded(className, fieldName, type) {
    if (type && type.type === 'Polygon') {
      const index = {
        [fieldName]: '2dsphere'
      };
      return this.createIndex(className, index);
    }
    return Promise.resolve();
  }

  createTextIndexesIfNeeded(className, query, schema) {
    for (const fieldName in query) {
      if (!query[fieldName] || !query[fieldName].$text) {
        continue;
      }
      const existingIndexes = schema.indexes;
      for (const key in existingIndexes) {
        const index = existingIndexes[key];
        if (index.hasOwnProperty(fieldName)) {
          return Promise.resolve();
        }
      }
      const indexName = `${fieldName}_text`;
      const textIndex = {
        [indexName]: { [fieldName]: 'text' }
      };
      return this.setIndexesWithSchemaFormat(className, textIndex, existingIndexes, schema.fields).catch(error => {
        if (error.code === 85) {
          // Index exist with different options
          return this.setIndexesFromMongo(className);
        }
        throw error;
      });
    }
    return Promise.resolve();
  }

  getIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.indexes()).catch(err => this.handleError(err));
  }

  dropIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndex(index)).catch(err => this.handleError(err));
  }

  dropAllIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndexes()).catch(err => this.handleError(err));
  }

  updateSchemaWithIndexes() {
    return this.getAllClasses().then(classes => {
      const promises = classes.map(schema => {
        return this.setIndexesFromMongo(schema.className);
      });
      return Promise.all(promises);
    }).catch(err => this.handleError(err));
  }
}

exports.MongoStorageAdapter = MongoStorageAdapter;
exports.default = MongoStorageAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvU3RvcmFnZUFkYXB0ZXIuanMiXSwibmFtZXMiOlsibW9uZ29kYiIsInJlcXVpcmUiLCJNb25nb0NsaWVudCIsIlJlYWRQcmVmZXJlbmNlIiwiTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSIsInN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMiLCJtb25nb0FkYXB0ZXIiLCJjb25uZWN0IiwidGhlbiIsImRhdGFiYXNlIiwiY29sbGVjdGlvbnMiLCJmaWx0ZXIiLCJjb2xsZWN0aW9uIiwibmFtZXNwYWNlIiwibWF0Y2giLCJjb2xsZWN0aW9uTmFtZSIsImluZGV4T2YiLCJfY29sbGVjdGlvblByZWZpeCIsImNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEiLCJzY2hlbWEiLCJmaWVsZHMiLCJfcnBlcm0iLCJfd3Blcm0iLCJjbGFzc05hbWUiLCJfaGFzaGVkX3Bhc3N3b3JkIiwibW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiaW5kZXhlcyIsIm1vbmdvT2JqZWN0IiwiX2lkIiwib2JqZWN0SWQiLCJ1cGRhdGVkQXQiLCJjcmVhdGVkQXQiLCJfbWV0YWRhdGEiLCJ1bmRlZmluZWQiLCJmaWVsZE5hbWUiLCJNb25nb1NjaGVtYUNvbGxlY3Rpb24iLCJwYXJzZUZpZWxkVHlwZVRvTW9uZ29GaWVsZFR5cGUiLCJjbGFzc19wZXJtaXNzaW9ucyIsIk9iamVjdCIsImtleXMiLCJsZW5ndGgiLCJNb25nb1N0b3JhZ2VBZGFwdGVyIiwiY29uc3RydWN0b3IiLCJ1cmkiLCJkZWZhdWx0cyIsIkRlZmF1bHRNb25nb1VSSSIsImNvbGxlY3Rpb25QcmVmaXgiLCJtb25nb09wdGlvbnMiLCJfdXJpIiwiX21vbmdvT3B0aW9ucyIsIl9tYXhUaW1lTVMiLCJtYXhUaW1lTVMiLCJjYW5Tb3J0T25Kb2luVGFibGVzIiwiY29ubmVjdGlvblByb21pc2UiLCJlbmNvZGVkVXJpIiwiY2xpZW50Iiwib3B0aW9ucyIsInMiLCJkYiIsImRiTmFtZSIsIm9uIiwiY2F0Y2giLCJlcnIiLCJQcm9taXNlIiwicmVqZWN0IiwiaGFuZGxlRXJyb3IiLCJlcnJvciIsImNvZGUiLCJsb2dnZXIiLCJoYW5kbGVTaHV0ZG93biIsImNsb3NlIiwiX2FkYXB0aXZlQ29sbGVjdGlvbiIsIm5hbWUiLCJyYXdDb2xsZWN0aW9uIiwiTW9uZ29Db2xsZWN0aW9uIiwiX3NjaGVtYUNvbGxlY3Rpb24iLCJjbGFzc0V4aXN0cyIsImxpc3RDb2xsZWN0aW9ucyIsInRvQXJyYXkiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJDTFBzIiwic2NoZW1hQ29sbGVjdGlvbiIsInVwZGF0ZVNjaGVtYSIsIiRzZXQiLCJzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdCIsInN1Ym1pdHRlZEluZGV4ZXMiLCJleGlzdGluZ0luZGV4ZXMiLCJyZXNvbHZlIiwiX2lkXyIsImRlbGV0ZVByb21pc2VzIiwiaW5zZXJ0ZWRJbmRleGVzIiwiZm9yRWFjaCIsImZpZWxkIiwiX19vcCIsIlBhcnNlIiwiRXJyb3IiLCJJTlZBTElEX1FVRVJZIiwicHJvbWlzZSIsImRyb3BJbmRleCIsInB1c2giLCJrZXkiLCJoYXNPd25Qcm9wZXJ0eSIsImluc2VydFByb21pc2UiLCJjcmVhdGVJbmRleGVzIiwiYWxsIiwic2V0SW5kZXhlc0Zyb21Nb25nbyIsImdldEluZGV4ZXMiLCJyZWR1Y2UiLCJvYmoiLCJpbmRleCIsIl9mdHMiLCJfZnRzeCIsIndlaWdodHMiLCJjcmVhdGVDbGFzcyIsImluc2VydFNjaGVtYSIsImFkZEZpZWxkSWZOb3RFeGlzdHMiLCJ0eXBlIiwiY3JlYXRlSW5kZXhlc0lmTmVlZGVkIiwiZGVsZXRlQ2xhc3MiLCJkcm9wIiwibWVzc2FnZSIsImZpbmRBbmREZWxldGVTY2hlbWEiLCJkZWxldGVBbGxDbGFzc2VzIiwiZmFzdCIsIm1hcCIsInJlbW92ZSIsImRlbGV0ZUZpZWxkcyIsImZpZWxkTmFtZXMiLCJtb25nb0Zvcm1hdE5hbWVzIiwiY29sbGVjdGlvblVwZGF0ZSIsInNjaGVtYVVwZGF0ZSIsInVwZGF0ZU1hbnkiLCJnZXRBbGxDbGFzc2VzIiwic2NoZW1hc0NvbGxlY3Rpb24iLCJfZmV0Y2hBbGxTY2hlbWFzRnJvbV9TQ0hFTUEiLCJnZXRDbGFzcyIsIl9mZXRjaE9uZVNjaGVtYUZyb21fU0NIRU1BIiwiY3JlYXRlT2JqZWN0Iiwib2JqZWN0IiwiaW5zZXJ0T25lIiwiRFVQTElDQVRFX1ZBTFVFIiwidW5kZXJseWluZ0Vycm9yIiwibWF0Y2hlcyIsIkFycmF5IiwiaXNBcnJheSIsInVzZXJJbmZvIiwiZHVwbGljYXRlZF9maWVsZCIsImRlbGV0ZU9iamVjdHNCeVF1ZXJ5IiwicXVlcnkiLCJtb25nb1doZXJlIiwiZGVsZXRlTWFueSIsInJlc3VsdCIsIm4iLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwidXBkYXRlT2JqZWN0c0J5UXVlcnkiLCJ1cGRhdGUiLCJtb25nb1VwZGF0ZSIsImZpbmRPbmVBbmRVcGRhdGUiLCJfbW9uZ29Db2xsZWN0aW9uIiwiZmluZEFuZE1vZGlmeSIsIm5ldyIsInZhbHVlIiwidXBzZXJ0T25lT2JqZWN0IiwidXBzZXJ0T25lIiwiZmluZCIsInNraXAiLCJsaW1pdCIsInNvcnQiLCJyZWFkUHJlZmVyZW5jZSIsIm1vbmdvU29ydCIsIl8iLCJtYXBLZXlzIiwibW9uZ29LZXlzIiwibWVtbyIsIl9wYXJzZVJlYWRQcmVmZXJlbmNlIiwiY3JlYXRlVGV4dEluZGV4ZXNJZk5lZWRlZCIsIm9iamVjdHMiLCJlbnN1cmVVbmlxdWVuZXNzIiwiaW5kZXhDcmVhdGlvblJlcXVlc3QiLCJtb25nb0ZpZWxkTmFtZXMiLCJfZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQiLCJfcmF3RmluZCIsImNvdW50IiwiZGlzdGluY3QiLCJpc1BvaW50ZXJGaWVsZCIsInN1YnN0cmluZyIsImFnZ3JlZ2F0ZSIsInBpcGVsaW5lIiwic3RhZ2UiLCIkZ3JvdXAiLCJfcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3MiLCIkbWF0Y2giLCJfcGFyc2VBZ2dyZWdhdGVBcmdzIiwiJHByb2plY3QiLCJfcGFyc2VBZ2dyZWdhdGVQcm9qZWN0QXJncyIsInJlc3VsdHMiLCJzcGxpdCIsImlzRW1wdHkiLCJyZXR1cm5WYWx1ZSIsInRhcmdldENsYXNzIiwiX2NvbnZlcnRUb0RhdGUiLCJEYXRlIiwiUFJJTUFSWSIsIlBSSU1BUllfUFJFRkVSUkVEIiwiU0VDT05EQVJZIiwiU0VDT05EQVJZX1BSRUZFUlJFRCIsIk5FQVJFU1QiLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCJjcmVhdGVJbmRleCIsIiR0ZXh0IiwiaW5kZXhOYW1lIiwidGV4dEluZGV4IiwiZHJvcEFsbEluZGV4ZXMiLCJkcm9wSW5kZXhlcyIsInVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzIiwiY2xhc3NlcyIsInByb21pc2VzIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOztBQUtBOztBQUlBOztBQVNBOzs7O0FBRUE7Ozs7QUFDQTs7OztBQUNBOzs7Ozs7O0FBTEE7O0FBRUE7OztBQUtBO0FBQ0EsTUFBTUEsVUFBVUMsUUFBUSxTQUFSLENBQWhCO0FBQ0EsTUFBTUMsY0FBY0YsUUFBUUUsV0FBNUI7QUFDQSxNQUFNQyxpQkFBaUJILFFBQVFHLGNBQS9COztBQUVBLE1BQU1DLDRCQUE0QixTQUFsQzs7QUFFQSxNQUFNQywrQkFBK0JDLGdCQUFnQjtBQUNuRCxTQUFPQSxhQUFhQyxPQUFiLEdBQ0pDLElBREksQ0FDQyxNQUFNRixhQUFhRyxRQUFiLENBQXNCQyxXQUF0QixFQURQLEVBRUpGLElBRkksQ0FFQ0UsZUFBZTtBQUNuQixXQUFPQSxZQUFZQyxNQUFaLENBQW1CQyxjQUFjO0FBQ3RDLFVBQUlBLFdBQVdDLFNBQVgsQ0FBcUJDLEtBQXJCLENBQTJCLFlBQTNCLENBQUosRUFBOEM7QUFDNUMsZUFBTyxLQUFQO0FBQ0Q7QUFDRDtB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LEVBRUptQyxLQUZJLENBRUVDLE9BQU8sS0FBS0csV0FBTCxDQUFpQkgsR0FBakIsQ0FGVCxDQUFQO0FBR0Q7O0FBRURvQyxZQUFVNUUsU0FBVixFQUE2QnVGLEtBQTdCLEVBQXlDO0FBQ3ZDLFdBQU8sS0FBS3RDLG1CQUFMLENBQXlCakQsU0FBekIsRUFDSmYsSUFESSxDQUNDSSxjQUFjQSxXQUFXb0osZ0JBQVgsQ0FBNEI3RCxTQUE1QixDQUFzQ1csS0FBdEMsQ0FEZixFQUVKaEQsS0FGSSxDQUVFQyxPQUFPLEtBQUtHLFdBQUwsQ0FBaUJILEdBQWpCLENBRlQsQ0FBUDtBQUdEOztBQUVEdUosaUJBQWUvTCxTQUFmLEVBQWtDO0FBQ2hDLFdBQU8sS0FBS2lELG1CQUFMLENBQXlCakQsU0FBekIsRUFDSmYsSUFESSxDQUNDSSxjQUFjQSxXQUFXb0osZ0JBQVgsQ0FBNEJ1RCxXQUE1QixFQURmLEVBRUp6SixLQUZJLENBRUVDLE9BQU8sS0FBS0csV0FBTCxDQUFpQkgsR0FBakIsQ0FGVCxDQUFQO0FBR0Q7O0FBRUR5Siw0QkFBd0M7QUFDdEMsV0FBTyxLQUFLbkYsYUFBTCxHQUNKN0gsSUFESSxDQUNFaU4sT0FBRCxJQUFhO0FBQ2pCLFlBQU1DLFdBQVdELFFBQVE1RixHQUFSLENBQWExRyxNQUFELElBQVk7QUFDdkMsZUFBTyxLQUFLdUYsbUJBQUwsQ0FBeUJ2RixPQUFPSSxTQUFoQyxDQUFQO0FBQ0QsT0FGZ0IsQ0FBakI7QUFHQSxhQUFPeUMsUUFBUXlDLEdBQVIsQ0FBWWlILFFBQVosQ0FBUDtBQUNELEtBTkksRUFPSjVKLEtBUEksQ0FPRUMsT0FBTyxLQUFLRyxXQUFMLENBQWlCSCxHQUFqQixDQVBULENBQVA7QUFRRDtBQTV0QndEOztRQUE5Q3JCLG1CLEdBQUFBLG1CO2tCQSt0QkVBLG1CIiwiZmlsZSI6Ik1vbmdvU3RvcmFnZUFkYXB0ZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAZmxvd1xuaW1wb3J0IE1vbmdvQ29sbGVjdGlvbiAgICAgICBmcm9tICcuL01vbmdvQ29sbGVjdGlvbic7XG5pbXBvcnQgTW9uZ29TY2hlbWFDb2xsZWN0aW9uIGZyb20gJy4vTW9uZ29TY2hlbWFDb2xsZWN0aW9uJztcbmltcG9ydCB7IFN0b3JhZ2VBZGFwdGVyIH0gICAgZnJvbSAnLi4vU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHR5cGUgeyBTY2hlbWFUeXBlLFxuICBRdWVyeVR5cGUsXG4gIFN0b3JhZ2VDbGFzcyxcbiAgUXVlcnlPcHRpb25zIH0gZnJvbSAnLi4vU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHtcbiAgcGFyc2UgYXMgcGFyc2VVcmwsXG4gIGZvcm1hdCBhcyBmb3JtYXRVcmwsXG59IGZyb20gJy4uLy4uLy4uL3ZlbmRvci9tb25nb2RiVXJsJztcbmltcG9ydCB7XG4gIHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZSxcbiAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0LFxuICB0cmFuc2Zvcm1LZXksXG4gIHRyYW5zZm9ybVdoZXJlLFxuICB0cmFuc2Zvcm1VcGRhdGUsXG4gIHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcsXG59IGZyb20gJy4vTW9uZ29UcmFuc2Zvcm0nO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgUGFyc2UgICAgICAgICAgICAgICAgIGZyb20gJ3BhcnNlL25vZGUnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgXyAgICAgICAgICAgICAgICAgICAgIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgZGVmYXVsdHMgICAgICAgICAgICAgIGZyb20gJy4uLy4uLy4uL2RlZmF1bHRzJztcbmltcG9ydCBsb2dnZXIgICAgICAgICAgICAgICAgZnJvbSAnLi4vLi4vLi4vbG9nZ2VyJztcblxuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5jb25zdCBtb25nb2RiID0gcmVxdWlyZSgnbW9uZ29kYicpO1xuY29uc3QgTW9uZ29DbGllbnQgPSBtb25nb2RiLk1vbmdvQ2xpZW50O1xuY29uc3QgUmVhZFByZWZlcmVuY2UgPSBtb25nb2RiLlJlYWRQcmVmZXJlbmNlO1xuXG5jb25zdCBNb25nb1NjaGVtYUNvbGxlY3Rpb25OYW1lID0gJ19TQ0hFTUEnO1xuXG5jb25zdCBzdG9yYWdlQWRhcHRlckFsbENvbGxlY3Rpb25zID0gbW9uZ29BZGFwdGVyID0+IHtcbiAgcmV0dXJuIG1vbmdvQWRhcHRlci5jb25uZWN0KClcbiAgICAudGhlbigoKSA9PiBtb25nb0FkYXB0ZXIuZGF0YWJhc2UuY29sbGVjdGlvbnMoKSlcbiAgICAudGhlbihjb2xsZWN0aW9ucyA9PiB7XG4gICAgICByZXR1cm4gY29sbGVjdGlvbnMuZmlsdGVyKGNvbGxlY3Rpb24gPT4ge1xuICAgICAgICBpZiAoY29sbGVjdGlvbi5uYW1lc3BhY2UubWF0Y2goL1xcLnN5c3RlbVxcLi8pKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIC8vIFRPRE86IElmIHlvdSBoYXZlIG9uZSBhcHAgd2l0aCBhIGNvbGxlY3Rpb24gcHJlZml4IHRoYXQgaGFwcGVucyB0byBiZSBhIHByZWZpeCBvZiBhbm90aGVyXG4gICAgICAgIC8vIGFwcHMgcHJlZml4LCB0aGlzIHdpbGwgZ28gdmVyeSB2ZXJ5IGJhZGx5LiBXZSBzaG91bGQgZml4IHRoYXQgc29tZWhvdy5cbiAgICAgICAgcmV0dXJuIChjb2xsZWN0aW9uLmNvbGxlY3Rpb25OYW1lLmluZGV4T2YobW9uZ29BZGFwdGVyLl9jb2xsZWN0aW9uUHJlZml4KSA9PSAwKTtcbiAgICAgIH0pO1xuICAgIH0pO1xufVxuXG5jb25zdCBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hID0gKHsuLi5zY2hlbWF9KSA9PiB7XG4gIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9ycGVybTtcbiAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3dwZXJtO1xuXG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgLy8gTGVnYWN5IG1vbmdvIGFkYXB0ZXIga25vd3MgYWJvdXQgdGhlIGRpZmZlcmVuY2UgYmV0d2VlbiBwYXNzd29yZCBhbmQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBGdXR1cmUgZGF0YWJhc2UgYWRhcHRlcnMgd2lsbCBvbmx5IGtub3cgYWJvdXQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBOb3RlOiBQYXJzZSBTZXJ2ZXIgd2lsbCBicmluZyBiYWNrIHBhc3N3b3JkIHdpdGggaW5qZWN0RGVmYXVsdFNjaGVtYSwgc28gd2UgZG9uJ3QgbmVlZFxuICAgIC8vIHRvIGFkZCBfaGFzaGVkX3Bhc3N3b3JkIGJhY2sgZXZlci5cbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkO1xuICB9XG5cbiAgcmV0dXJuIHNjaGVtYTtcbn1cblxuLy8gUmV0dXJucyB7IGNvZGUsIGVycm9yIH0gaWYgaW52YWxpZCwgb3IgeyByZXN1bHQgfSwgYW4gb2JqZWN0XG4vLyBzdWl0YWJsZSBmb3IgaW5zZXJ0aW5nIGludG8gX1NDSEVNQSBjb2xsZWN0aW9uLCBvdGhlcndpc2UuXG5jb25zdCBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAgPSAoZmllbGRzLCBjbGFzc05hbWUsIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucywgaW5kZXhlcykgPT4ge1xuICBjb25zdCBtb25nb09iamVjdCA9IHtcbiAgICBfaWQ6IGNsYXNzTmFtZSxcbiAgICBvYmplY3RJZDogJ3N0cmluZycsXG4gICAgdXBkYXRlZEF0OiAnc3RyaW5nJyxcbiAgICBjcmVhdGVkQXQ6ICdzdHJpbmcnLFxuICAgIF9tZXRhZGF0YTogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGZvciAoY29uc3QgZmllbGROYW1lIGluIGZpZWxkcykge1xuICAgIG1vbmdvT2JqZWN0W2ZpZWxkTmFtZV0gPSBNb25nb1NjaGVtYUNvbGxlY3Rpb24ucGFyc2VGaWVsZFR5cGVUb01vbmdvRmllbGRUeXBlKGZpZWxkc1tmaWVsZE5hbWVdKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgY2xhc3NMZXZlbFBlcm1pc3Npb25zICE9PSAndW5kZWZpbmVkJykge1xuICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSA9IG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSB8fCB7fTtcbiAgICBpZiAoIWNsYXNzTGV2ZWxQZXJtaXNzaW9ucykge1xuICAgICAgZGVsZXRlIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucztcbiAgICB9IGVsc2Uge1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zID0gY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgIH1cbiAgfVxuXG4gIGlmIChpbmRleGVzICYmIHR5cGVvZiBpbmRleGVzID09PSAnb2JqZWN0JyAmJiBPYmplY3Qua2V5cyhpbmRleGVzKS5sZW5ndGggPiAwKSB7XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhID0gbW9uZ29PYmplY3QuX21ldGFkYXRhIHx8IHt9O1xuICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5pbmRleGVzID0gaW5kZXhlcztcbiAgfVxuXG4gIGlmICghbW9uZ29PYmplY3QuX21ldGFkYXRhKSB7IC8vIGNsZWFudXAgdGhlIHVudXNlZCBfbWV0YWRhdGFcbiAgICBkZWxldGUgbW9uZ29PYmplY3QuX21ldGFkYXRhO1xuICB9XG5cbiAgcmV0dXJuIG1vbmdvT2JqZWN0O1xufVxuXG5cbmV4cG9ydCBjbGFzcyBNb25nb1N0b3JhZ2VBZGFwdGVyIGltcGxlbWVudHMgU3RvcmFnZUFkYXB0ZXIge1xuICAvLyBQcml2YXRlXG4gIF91cmk6IHN0cmluZztcbiAgX2NvbGxlY3Rpb25QcmVmaXg6IHN0cmluZztcbiAgX21vbmdvT3B0aW9uczogT2JqZWN0O1xuICAvLyBQdWJsaWNcbiAgY29ubmVjdGlvblByb21pc2U6IFByb21pc2U8YW55PjtcbiAgZGF0YWJhc2U6IGFueTtcbiAgY2xpZW50OiBNb25nb0NsaWVudDtcbiAgX21heFRpbWVNUzogP251bWJlcjtcbiAgY2FuU29ydE9uSm9pblRhYmxlczogYm9vbGVhbjtcblxuICBjb25zdHJ1Y3Rvcih7XG4gICAgdXJpID0gZGVmYXVsdHMuRGVmYXVsdE1vbmdvVVJJLFxuICAgIGNvbGxlY3Rpb25QcmVmaXggPSAnJyxcbiAgICBtb25nb09wdGlvbnMgPSB7fSxcbiAgfTogYW55KSB7XG4gICAgdGhpcy5fdXJpID0gdXJpO1xuICAgIHRoaXMuX2NvbGxlY3Rpb25QcmVmaXggPSBjb2xsZWN0aW9uUHJlZml4O1xuICAgIHRoaXMuX21vbmdvT3B0aW9ucyA9IG1vbmdvT3B0aW9ucztcblxuICAgIC8vIE1heFRpbWVNUyBpcyBub3QgYSBnbG9iYWwgTW9uZ29EQiBjbGllbnQgb3B0aW9uLCBpdCBpcyBhcHBsaWVkIHBlciBvcGVyYXRpb24uXG4gICAgdGhpcy5fbWF4VGltZU1TID0gbW9uZ29PcHRpb25zLm1heFRpbWVNUztcbiAgICB0aGlzLmNhblNvcnRPbkpvaW5UYWJsZXMgPSB0cnVlO1xuICAgIGRlbGV0ZSBtb25nb09wdGlvbnMubWF4VGltZU1TO1xuICB9XG5cbiAgY29ubmVjdCgpIHtcbiAgICBpZiAodGhpcy5jb25uZWN0aW9uUHJvbWlzZSkge1xuICAgICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgfVxuXG4gICAgLy8gcGFyc2luZyBhbmQgcmUtZm9ybWF0dGluZyBjYXVzZXMgdGhlIGF1dGggdmFsdWUgKGlmIHRoZXJlKSB0byBnZXQgVVJJXG4gICAgLy8gZW5jb2RlZFxuICAgIGNvbnN0IGVuY29kZWRVcmkgPSBmb3JtYXRVcmwocGFyc2VVcmwodGhpcy5fdXJpKSk7XG5cbiAgICB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlID0gTW9uZ29DbGllbnQuY29ubmVjdChlbmNvZGVkVXJpLCB0aGlzLl9tb25nb09wdGlvbnMpLnRoZW4oY2xpZW50ID0+IHtcbiAgICAgIC8vIFN0YXJ0aW5nIG1vbmdvREIgMy4wLCB0aGUgTW9uZ29DbGllbnQuY29ubmVjdCBkb24ndCByZXR1cm4gYSBEQiBhbnltb3JlIGJ1dCBhIGNsaWVudFxuICAgICAgLy8gRm9ydHVuYXRlbHksIHdlIGNhbiBnZXQgYmFjayB0aGUgb3B0aW9ucyBhbmQgdXNlIHRoZW0gdG8gc2VsZWN0IHRoZSBwcm9wZXIgREIuXG4gICAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vbW9uZ29kYi9ub2RlLW1vbmdvZGItbmF0aXZlL2Jsb2IvMmMzNWQ3NmYwODU3NDIyNWI4ZGIwMmQ3YmVmNjg3MTIzZTZiYjAxOC9saWIvbW9uZ29fY2xpZW50LmpzI0w4ODVcbiAgICAgIGNvbnN0IG9wdGlvbnMgPSBjbGllbnQucy5vcHRpb25zO1xuICAgICAgY29uc3QgZGF0YWJhc2UgPSBjbGllbnQuZGIob3B0aW9ucy5kYk5hbWUpO1xuICAgICAgaWYgKCFkYXRhYmFzZSkge1xuICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgZGF0YWJhc2Uub24oJ2Vycm9yJywgKCkgPT4ge1xuICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgIH0pO1xuICAgICAgZGF0YWJhc2Uub24oJ2Nsb3NlJywgKCkgPT4ge1xuICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgIH0pO1xuICAgICAgdGhpcy5jbGllbnQgPSBjbGllbnQ7XG4gICAgICB0aGlzLmRhdGFiYXNlID0gZGF0YWJhc2U7XG4gICAgfSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgZGVsZXRlIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyKTtcbiAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICB9XG5cbiAgaGFuZGxlRXJyb3I8VD4oZXJyb3I6ID8oRXJyb3IgfCBQYXJzZS5FcnJvcikpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAoZXJyb3IgJiYgZXJyb3IuY29kZSA9PT0gMTMpIHsgLy8gVW5hdXRob3JpemVkIGVycm9yXG4gICAgICBkZWxldGUgdGhpcy5jbGllbnQ7XG4gICAgICBkZWxldGUgdGhpcy5kYXRhYmFzZTtcbiAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgbG9nZ2VyLmVycm9yKCdSZWNlaXZlZCB1bmF1dGhvcml6ZWQgZXJyb3InLCB7IGVycm9yOiBlcnJvciB9KTtcbiAgICB9XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cblxuICBoYW5kbGVTaHV0ZG93bigpIHtcbiAgICBpZiAoIXRoaXMuY2xpZW50KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuY2xpZW50LmNsb3NlKGZhbHNlKTtcbiAgfVxuXG4gIF9hZGFwdGl2ZUNvbGxlY3Rpb24obmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuY29ubmVjdCgpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmRhdGFiYXNlLmNvbGxlY3Rpb24odGhpcy5fY29sbGVjdGlvblByZWZpeCArIG5hbWUpKVxuICAgICAgLnRoZW4ocmF3Q29sbGVjdGlvbiA9PiBuZXcgTW9uZ29Db2xsZWN0aW9uKHJhd0NvbGxlY3Rpb24pKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgX3NjaGVtYUNvbGxlY3Rpb24oKTogUHJvbWlzZTxNb25nb1NjaGVtYUNvbGxlY3Rpb24+IHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihNb25nb1NjaGVtYUNvbGxlY3Rpb25OYW1lKSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gbmV3IE1vbmdvU2NoZW1hQ29sbGVjdGlvbihjb2xsZWN0aW9uKSk7XG4gIH1cblxuICBjbGFzc0V4aXN0cyhuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KCkudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kYXRhYmFzZS5saXN0Q29sbGVjdGlvbnMoeyBuYW1lOiB0aGlzLl9jb2xsZWN0aW9uUHJlZml4ICsgbmFtZSB9KS50b0FycmF5KCk7XG4gICAgfSkudGhlbihjb2xsZWN0aW9ucyA9PiB7XG4gICAgICByZXR1cm4gY29sbGVjdGlvbnMubGVuZ3RoID4gMDtcbiAgICB9KS5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWU6IHN0cmluZywgQ0xQczogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zJzogQ0xQcyB9XG4gICAgICB9KSkuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdChjbGFzc05hbWU6IHN0cmluZywgc3VibWl0dGVkSW5kZXhlczogYW55LCBleGlzdGluZ0luZGV4ZXM6IGFueSA9IHt9LCBmaWVsZHM6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdWJtaXR0ZWRJbmRleGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKGV4aXN0aW5nSW5kZXhlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICBleGlzdGluZ0luZGV4ZXMgPSB7IF9pZF86IHsgX2lkOiAxfSB9O1xuICAgIH1cbiAgICBjb25zdCBkZWxldGVQcm9taXNlcyA9IFtdO1xuICAgIGNvbnN0IGluc2VydGVkSW5kZXhlcyA9IFtdO1xuICAgIE9iamVjdC5rZXlzKHN1Ym1pdHRlZEluZGV4ZXMpLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb25zdCBmaWVsZCA9IHN1Ym1pdHRlZEluZGV4ZXNbbmFtZV07XG4gICAgICBpZiAoZXhpc3RpbmdJbmRleGVzW25hbWVdICYmIGZpZWxkLl9fb3AgIT09ICdEZWxldGUnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCBgSW5kZXggJHtuYW1lfSBleGlzdHMsIGNhbm5vdCB1cGRhdGUuYCk7XG4gICAgICB9XG4gICAgICBpZiAoIWV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYEluZGV4ICR7bmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYCk7XG4gICAgICB9XG4gICAgICBpZiAoZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgY29uc3QgcHJvbWlzZSA9IHRoaXMuZHJvcEluZGV4KGNsYXNzTmFtZSwgbmFtZSk7XG4gICAgICAgIGRlbGV0ZVByb21pc2VzLnB1c2gocHJvbWlzZSk7XG4gICAgICAgIGRlbGV0ZSBleGlzdGluZ0luZGV4ZXNbbmFtZV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBPYmplY3Qua2V5cyhmaWVsZCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgIGlmICghZmllbGRzLmhhc093blByb3BlcnR5KGtleSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCBgRmllbGQgJHtrZXl9IGRvZXMgbm90IGV4aXN0LCBjYW5ub3QgYWRkIGluZGV4LmApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGV4aXN0aW5nSW5kZXhlc1tuYW1lXSA9IGZpZWxkO1xuICAgICAgICBpbnNlcnRlZEluZGV4ZXMucHVzaCh7XG4gICAgICAgICAga2V5OiBmaWVsZCxcbiAgICAgICAgICBuYW1lLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBsZXQgaW5zZXJ0UHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGlmIChpbnNlcnRlZEluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgaW5zZXJ0UHJvbWlzZSA9IHRoaXMuY3JlYXRlSW5kZXhlcyhjbGFzc05hbWUsIGluc2VydGVkSW5kZXhlcyk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLmFsbChkZWxldGVQcm9taXNlcylcbiAgICAgIC50aGVuKCgpID0+IGluc2VydFByb21pc2UpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwge1xuICAgICAgICAkc2V0OiB7ICdfbWV0YWRhdGEuaW5kZXhlcyc6ICBleGlzdGluZ0luZGV4ZXMgfVxuICAgICAgfSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBzZXRJbmRleGVzRnJvbU1vbmdvKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuZ2V0SW5kZXhlcyhjbGFzc05hbWUpLnRoZW4oKGluZGV4ZXMpID0+IHtcbiAgICAgIGluZGV4ZXMgPSBpbmRleGVzLnJlZHVjZSgob2JqLCBpbmRleCkgPT4ge1xuICAgICAgICBpZiAoaW5kZXgua2V5Ll9mdHMpIHtcbiAgICAgICAgICBkZWxldGUgaW5kZXgua2V5Ll9mdHM7XG4gICAgICAgICAgZGVsZXRlIGluZGV4LmtleS5fZnRzeDtcbiAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIGluZGV4LndlaWdodHMpIHtcbiAgICAgICAgICAgIGluZGV4LmtleVtmaWVsZF0gPSAndGV4dCc7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIG9ialtpbmRleC5uYW1lXSA9IGluZGV4LmtleTtcbiAgICAgICAgcmV0dXJuIG9iajtcbiAgICAgIH0sIHt9KTtcbiAgICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgICAkc2V0OiB7ICdfbWV0YWRhdGEuaW5kZXhlcyc6IGluZGV4ZXMgfVxuICAgICAgICB9KSk7XG4gICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKVxuICAgICAgLmNhdGNoKCgpID0+IHtcbiAgICAgICAgLy8gSWdub3JlIGlmIGNvbGxlY3Rpb24gbm90IGZvdW5kXG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgY3JlYXRlQ2xhc3MoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb09iamVjdCA9IG1vbmdvU2NoZW1hRnJvbUZpZWxkc0FuZENsYXNzTmFtZUFuZENMUChzY2hlbWEuZmllbGRzLCBjbGFzc05hbWUsIHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMsIHNjaGVtYS5pbmRleGVzKTtcbiAgICBtb25nb09iamVjdC5faWQgPSBjbGFzc05hbWU7XG4gICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoY2xhc3NOYW1lLCBzY2hlbWEuaW5kZXhlcywge30sIHNjaGVtYS5maWVsZHMpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uaW5zZXJ0U2NoZW1hKG1vbmdvT2JqZWN0KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGFkZEZpZWxkSWZOb3RFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uYWRkRmllbGRJZk5vdEV4aXN0cyhjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmNyZWF0ZUluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBEcm9wcyBhIGNvbGxlY3Rpb24uIFJlc29sdmVzIHdpdGggdHJ1ZSBpZiBpdCB3YXMgYSBQYXJzZSBTY2hlbWEgKGVnLiBfVXNlciwgQ3VzdG9tLCBldGMuKVxuICAvLyBhbmQgcmVzb2x2ZXMgd2l0aCBmYWxzZSBpZiBpdCB3YXNuJ3QgKGVnLiBhIGpvaW4gdGFibGUpLiBSZWplY3RzIGlmIGRlbGV0aW9uIHdhcyBpbXBvc3NpYmxlLlxuICBkZWxldGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmRyb3AoKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAvLyAnbnMgbm90IGZvdW5kJyBtZWFucyBjb2xsZWN0aW9uIHdhcyBhbHJlYWR5IGdvbmUuIElnbm9yZSBkZWxldGlvbiBhdHRlbXB0LlxuICAgICAgICBpZiAoZXJyb3IubWVzc2FnZSA9PSAnbnMgbm90IGZvdW5kJykge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgLy8gV2UndmUgZHJvcHBlZCB0aGUgY29sbGVjdGlvbiwgbm93IHJlbW92ZSB0aGUgX1NDSEVNQSBkb2N1bWVudFxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLmZpbmRBbmREZWxldGVTY2hlbWEoY2xhc3NOYW1lKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGRlbGV0ZUFsbENsYXNzZXMoZmFzdDogYm9vbGVhbikge1xuICAgIHJldHVybiBzdG9yYWdlQWRhcHRlckFsbENvbGxlY3Rpb25zKHRoaXMpXG4gICAgICAudGhlbihjb2xsZWN0aW9ucyA9PiBQcm9taXNlLmFsbChjb2xsZWN0aW9ucy5tYXAoY29sbGVjdGlvbiA9PiBmYXN0ID8gY29sbGVjdGlvbi5yZW1vdmUoe30pIDogY29sbGVjdGlvbi5kcm9wKCkpKSk7XG4gIH1cblxuICAvLyBSZW1vdmUgdGhlIGNvbHVtbiBhbmQgYWxsIHRoZSBkYXRhLiBGb3IgUmVsYXRpb25zLCB0aGUgX0pvaW4gY29sbGVjdGlvbiBpcyBoYW5kbGVkXG4gIC8vIHNwZWNpYWxseSwgdGhpcyBmdW5jdGlvbiBkb2VzIG5vdCBkZWxldGUgX0pvaW4gY29sdW1ucy4gSXQgc2hvdWxkLCBob3dldmVyLCBpbmRpY2F0ZVxuICAvLyB0aGF0IHRoZSByZWxhdGlvbiBmaWVsZHMgZG9lcyBub3QgZXhpc3QgYW55bW9yZS4gSW4gbW9uZ28sIHRoaXMgbWVhbnMgcmVtb3ZpbmcgaXQgZnJvbVxuICAvLyB0aGUgX1NDSEVNQSBjb2xsZWN0aW9uLiAgVGhlcmUgc2hvdWxkIGJlIG5vIGFjdHVhbCBkYXRhIGluIHRoZSBjb2xsZWN0aW9uIHVuZGVyIHRoZSBzYW1lIG5hbWVcbiAgLy8gYXMgdGhlIHJlbGF0aW9uIGNvbHVtbiwgc28gaXQncyBmaW5lIHRvIGF0dGVtcHQgdG8gZGVsZXRlIGl0LiBJZiB0aGUgZmllbGRzIGxpc3RlZCB0byBiZVxuICAvLyBkZWxldGVkIGRvIG5vdCBleGlzdCwgdGhpcyBmdW5jdGlvbiBzaG91bGQgcmV0dXJuIHN1Y2Nlc3NmdWxseSBhbnl3YXlzLiBDaGVja2luZyBmb3JcbiAgLy8gYXR0ZW1wdHMgdG8gZGVsZXRlIG5vbi1leGlzdGVudCBmaWVsZHMgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIFBhcnNlIFNlcnZlci5cblxuICAvLyBQb2ludGVyIGZpZWxkIG5hbWVzIGFyZSBwYXNzZWQgZm9yIGxlZ2FjeSByZWFzb25zOiB0aGUgb3JpZ2luYWwgbW9uZ29cbiAgLy8gZm9ybWF0IHN0b3JlZCBwb2ludGVyIGZpZWxkIG5hbWVzIGRpZmZlcmVudGx5IGluIHRoZSBkYXRhYmFzZSwgYW5kIHRoZXJlZm9yZVxuICAvLyBuZWVkZWQgdG8ga25vdyB0aGUgdHlwZSBvZiB0aGUgZmllbGQgYmVmb3JlIGl0IGNvdWxkIGRlbGV0ZSBpdC4gRnV0dXJlIGRhdGFiYXNlXG4gIC8vIGFkYXB0ZXJzIHNob3VsZCBpZ25vcmUgdGhlIHBvaW50ZXJGaWVsZE5hbWVzIGFyZ3VtZW50LiBBbGwgdGhlIGZpZWxkIG5hbWVzIGFyZSBpblxuICAvLyBmaWVsZE5hbWVzLCB0aGV5IHNob3cgdXAgYWRkaXRpb25hbGx5IGluIHRoZSBwb2ludGVyRmllbGROYW1lcyBkYXRhYmFzZSBmb3IgdXNlXG4gIC8vIGJ5IHRoZSBtb25nbyBhZGFwdGVyLCB3aGljaCBkZWFscyB3aXRoIHRoZSBsZWdhY3kgbW9uZ28gZm9ybWF0LlxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgbm90IG9ibGlnYXRlZCB0byBkZWxldGUgZmllbGRzIGF0b21pY2FsbHkuIEl0IGlzIGdpdmVuIHRoZSBmaWVsZFxuICAvLyBuYW1lcyBpbiBhIGxpc3Qgc28gdGhhdCBkYXRhYmFzZXMgdGhhdCBhcmUgY2FwYWJsZSBvZiBkZWxldGluZyBmaWVsZHMgYXRvbWljYWxseVxuICAvLyBtYXkgZG8gc28uXG5cbiAgLy8gUmV0dXJucyBhIFByb21pc2UuXG4gIGRlbGV0ZUZpZWxkcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBmaWVsZE5hbWVzOiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IG1vbmdvRm9ybWF0TmFtZXMgPSBmaWVsZE5hbWVzLm1hcChmaWVsZE5hbWUgPT4ge1xuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGBfcF8ke2ZpZWxkTmFtZX1gXG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gZmllbGROYW1lO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNvbnN0IGNvbGxlY3Rpb25VcGRhdGUgPSB7ICckdW5zZXQnIDoge30gfTtcbiAgICBtb25nb0Zvcm1hdE5hbWVzLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb2xsZWN0aW9uVXBkYXRlWyckdW5zZXQnXVtuYW1lXSA9IG51bGw7XG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2hlbWFVcGRhdGUgPSB7ICckdW5zZXQnIDoge30gfTtcbiAgICBmaWVsZE5hbWVzLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBzY2hlbWFVcGRhdGVbJyR1bnNldCddW25hbWVdID0gbnVsbDtcbiAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwZGF0ZU1hbnkoe30sIGNvbGxlY3Rpb25VcGRhdGUpKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHNjaGVtYVVwZGF0ZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbGwgc2NoZW1hcyBrbm93biB0byB0aGlzIGFkYXB0ZXIsIGluIFBhcnNlIGZvcm1hdC4gSW4gY2FzZSB0aGVcbiAgLy8gc2NoZW1hcyBjYW5ub3QgYmUgcmV0cmlldmVkLCByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMuIFJlcXVpcmVtZW50cyBmb3IgdGhlXG4gIC8vIHJlamVjdGlvbiByZWFzb24gYXJlIFRCRC5cbiAgZ2V0QWxsQ2xhc3NlcygpOiBQcm9taXNlPFN0b3JhZ2VDbGFzc1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKS50aGVuKHNjaGVtYXNDb2xsZWN0aW9uID0+IHNjaGVtYXNDb2xsZWN0aW9uLl9mZXRjaEFsbFNjaGVtYXNGcm9tX1NDSEVNQSgpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgdGhlIHNjaGVtYSB3aXRoIHRoZSBnaXZlbiBuYW1lLCBpbiBQYXJzZSBmb3JtYXQuIElmXG4gIC8vIHRoaXMgYWRhcHRlciBkb2Vzbid0IGtub3cgYWJvdXQgdGhlIHNjaGVtYSwgcmV0dXJuIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMgd2l0aFxuICAvLyB1bmRlZmluZWQgYXMgdGhlIHJlYXNvbi5cbiAgZ2V0Q2xhc3MoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPFN0b3JhZ2VDbGFzcz4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHNjaGVtYXNDb2xsZWN0aW9uID0+IHNjaGVtYXNDb2xsZWN0aW9uLl9mZXRjaE9uZVNjaGVtYUZyb21fU0NIRU1BKGNsYXNzTmFtZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBUT0RPOiBBcyB5ZXQgbm90IHBhcnRpY3VsYXJseSB3ZWxsIHNwZWNpZmllZC4gQ3JlYXRlcyBhbiBvYmplY3QuIE1heWJlIHNob3VsZG4ndCBldmVuIG5lZWQgdGhlIHNjaGVtYSxcbiAgLy8gYW5kIHNob3VsZCBpbmZlciBmcm9tIHRoZSB0eXBlLiBPciBtYXliZSBkb2VzIG5lZWQgdGhlIHNjaGVtYSBmb3IgdmFsaWRhdGlvbnMuIE9yIG1heWJlIG5lZWRzXG4gIC8vIHRoZSBzY2hlbWEgb25seSBmb3IgdGhlIGxlZ2FjeSBtb25nbyBmb3JtYXQuIFdlJ2xsIGZpZ3VyZSB0aGF0IG91dCBsYXRlci5cbiAgY3JlYXRlT2JqZWN0KGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIG9iamVjdDogYW55KSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0ID0gcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlKGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmluc2VydE9uZShtb25nb09iamVjdCkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHsgLy8gRHVwbGljYXRlIHZhbHVlXG4gICAgICAgICAgY29uc3QgZXJyID0gbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSwgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnKTtcbiAgICAgICAgICBlcnIudW5kZXJseWluZ0Vycm9yID0gZXJyb3I7XG4gICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UpIHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZXMgPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9pbmRleDpbXFxzYS16QS1aMC05X1xcLVxcLl0rXFwkPyhbYS16QS1aXy1dKylfMS8pO1xuICAgICAgICAgICAgaWYgKG1hdGNoZXMgJiYgQXJyYXkuaXNBcnJheShtYXRjaGVzKSkge1xuICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IG1hdGNoZXNbMV0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFJlbW92ZSBhbGwgb2JqZWN0cyB0aGF0IG1hdGNoIHRoZSBnaXZlbiBQYXJzZSBRdWVyeS5cbiAgLy8gSWYgbm8gb2JqZWN0cyBtYXRjaCwgcmVqZWN0IHdpdGggT0JKRUNUX05PVF9GT1VORC4gSWYgb2JqZWN0cyBhcmUgZm91bmQgYW5kIGRlbGV0ZWQsIHJlc29sdmUgd2l0aCB1bmRlZmluZWQuXG4gIC8vIElmIHRoZXJlIGlzIHNvbWUgb3RoZXIgZXJyb3IsIHJlamVjdCB3aXRoIElOVEVSTkFMX1NFUlZFUl9FUlJPUi5cbiAgZGVsZXRlT2JqZWN0c0J5UXVlcnkoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgcXVlcnk6IFF1ZXJ5VHlwZSkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4ge1xuICAgICAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICAgICAgcmV0dXJuIGNvbGxlY3Rpb24uZGVsZXRlTWFueShtb25nb1doZXJlKVxuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKVxuICAgICAgLnRoZW4oKHsgcmVzdWx0IH0pID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdC5uID09PSAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0sICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUiwgJ0RhdGFiYXNlIGFkYXB0ZXIgZXJyb3InKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gQXBwbHkgdGhlIHVwZGF0ZSB0byBhbGwgb2JqZWN0cyB0aGF0IG1hdGNoIHRoZSBnaXZlbiBQYXJzZSBRdWVyeS5cbiAgdXBkYXRlT2JqZWN0c0J5UXVlcnkoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgcXVlcnk6IFF1ZXJ5VHlwZSwgdXBkYXRlOiBhbnkpIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24udXBkYXRlTWFueShtb25nb1doZXJlLCBtb25nb1VwZGF0ZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBBdG9taWNhbGx5IGZpbmRzIGFuZCB1cGRhdGVzIGFuIG9iamVjdCBiYXNlZCBvbiBxdWVyeS5cbiAgLy8gUmV0dXJuIHZhbHVlIG5vdCBjdXJyZW50bHkgd2VsbCBzcGVjaWZpZWQuXG4gIGZpbmRPbmVBbmRVcGRhdGUoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgcXVlcnk6IFF1ZXJ5VHlwZSwgdXBkYXRlOiBhbnkpIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5maW5kQW5kTW9kaWZ5KG1vbmdvV2hlcmUsIFtdLCBtb25nb1VwZGF0ZSwgeyBuZXc6IHRydWUgfSkpXG4gICAgICAudGhlbihyZXN1bHQgPT4gbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgcmVzdWx0LnZhbHVlLCBzY2hlbWEpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSwgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBIb3BlZnVsbHkgd2UgY2FuIGdldCByaWQgb2YgdGhpcy4gSXQncyBvbmx5IHVzZWQgZm9yIGNvbmZpZyBhbmQgaG9va3MuXG4gIHVwc2VydE9uZU9iamVjdChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBxdWVyeTogUXVlcnlUeXBlLCB1cGRhdGU6IGFueSkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1VwZGF0ZSA9IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi51cHNlcnRPbmUobW9uZ29XaGVyZSwgbW9uZ29VcGRhdGUpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRXhlY3V0ZXMgYSBmaW5kLiBBY2NlcHRzOiBjbGFzc05hbWUsIHF1ZXJ5IGluIFBhcnNlIGZvcm1hdCwgYW5kIHsgc2tpcCwgbGltaXQsIHNvcnQgfS5cbiAgZmluZChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBxdWVyeTogUXVlcnlUeXBlLCB7IHNraXAsIGxpbWl0LCBzb3J0LCBrZXlzLCByZWFkUHJlZmVyZW5jZSB9OiBRdWVyeU9wdGlvbnMpOiBQcm9taXNlPGFueT4ge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1NvcnQgPSBfLm1hcEtleXMoc29ydCwgKHZhbHVlLCBmaWVsZE5hbWUpID0+IHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKSk7XG4gICAgY29uc3QgbW9uZ29LZXlzID0gXy5yZWR1Y2Uoa2V5cywgKG1lbW8sIGtleSkgPT4ge1xuICAgICAgaWYgKGtleSA9PT0gJ0FDTCcpIHtcbiAgICAgICAgbWVtb1snX3JwZXJtJ10gPSAxO1xuICAgICAgICBtZW1vWydfd3Blcm0nXSA9IDE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZW1vW3RyYW5zZm9ybUtleShjbGFzc05hbWUsIGtleSwgc2NoZW1hKV0gPSAxO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG1lbW87XG4gICAgfSwge30pO1xuXG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmZpbmQobW9uZ29XaGVyZSwge1xuICAgICAgICBza2lwLFxuICAgICAgICBsaW1pdCxcbiAgICAgICAgc29ydDogbW9uZ29Tb3J0LFxuICAgICAgICBrZXlzOiBtb25nb0tleXMsXG4gICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgIH0pKVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiBvYmplY3RzLm1hcChvYmplY3QgPT4gbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIENyZWF0ZSBhIHVuaXF1ZSBpbmRleC4gVW5pcXVlIGluZGV4ZXMgb24gbnVsbGFibGUgZmllbGRzIGFyZSBub3QgYWxsb3dlZC4gU2luY2Ugd2UgZG9uJ3RcbiAgLy8gY3VycmVudGx5IGtub3cgd2hpY2ggZmllbGRzIGFyZSBudWxsYWJsZSBhbmQgd2hpY2ggYXJlbid0LCB3ZSBpZ25vcmUgdGhhdCBjcml0ZXJpYS5cbiAgLy8gQXMgc3VjaCwgd2Ugc2hvdWxkbid0IGV4cG9zZSB0aGlzIGZ1bmN0aW9uIHRvIHVzZXJzIG9mIHBhcnNlIHVudGlsIHdlIGhhdmUgYW4gb3V0LW9mLWJhbmRcbiAgLy8gV2F5IG9mIGRldGVybWluaW5nIGlmIGEgZmllbGQgaXMgbnVsbGFibGUuIFVuZGVmaW5lZCBkb2Vzbid0IGNvdW50IGFnYWluc3QgdW5pcXVlbmVzcyxcbiAgLy8gd2hpY2ggaXMgd2h5IHdlIHVzZSBzcGFyc2UgaW5kZXhlcy5cbiAgZW5zdXJlVW5pcXVlbmVzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBmaWVsZE5hbWVzOiBzdHJpbmdbXSkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBpbmRleENyZWF0aW9uUmVxdWVzdCA9IHt9O1xuICAgIGNvbnN0IG1vbmdvRmllbGROYW1lcyA9IGZpZWxkTmFtZXMubWFwKGZpZWxkTmFtZSA9PiB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSkpO1xuICAgIG1vbmdvRmllbGROYW1lcy5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICBpbmRleENyZWF0aW9uUmVxdWVzdFtmaWVsZE5hbWVdID0gMTtcbiAgICB9KTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQoaW5kZXhDcmVhdGlvblJlcXVlc3QpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSwgJ1RyaWVkIHRvIGVuc3VyZSBmaWVsZCB1bmlxdWVuZXNzIGZvciBhIGNsYXNzIHRoYXQgYWxyZWFkeSBoYXMgZHVwbGljYXRlcy4nKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBVc2VkIGluIHRlc3RzXG4gIF9yYXdGaW5kKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogUXVlcnlUeXBlKSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmZpbmQocXVlcnksIHtcbiAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgIH0pKS5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIEV4ZWN1dGVzIGEgY291bnQuXG4gIGNvdW50KGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIHF1ZXJ5OiBRdWVyeVR5cGUsIHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIHJlYWRQcmVmZXJlbmNlID0gdGhpcy5fcGFyc2VSZWFkUHJlZmVyZW5jZShyZWFkUHJlZmVyZW5jZSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uY291bnQodHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKSwge1xuICAgICAgICBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyxcbiAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICB9KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGRpc3RpbmN0KGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIHF1ZXJ5OiBRdWVyeVR5cGUsIGZpZWxkTmFtZTogc3RyaW5nKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGlzUG9pbnRlckZpZWxkID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUG9pbnRlcic7XG4gICAgaWYgKGlzUG9pbnRlckZpZWxkKSB7XG4gICAgICBmaWVsZE5hbWUgPSBgX3BfJHtmaWVsZE5hbWV9YFxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5kaXN0aW5jdChmaWVsZE5hbWUsIHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSkpKVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiB7XG4gICAgICAgIG9iamVjdHMgPSBvYmplY3RzLmZpbHRlcigob2JqKSA9PiBvYmogIT0gbnVsbCk7XG4gICAgICAgIHJldHVybiBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIGlmIChpc1BvaW50ZXJGaWVsZCkge1xuICAgICAgICAgICAgY29uc3QgZmllbGQgPSBmaWVsZE5hbWUuc3Vic3RyaW5nKDMpO1xuICAgICAgICAgICAgcmV0dXJuIHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcoc2NoZW1hLCBmaWVsZCwgb2JqZWN0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgfSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgYWdncmVnYXRlKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSwgcmVhZFByZWZlcmVuY2U6ID9zdHJpbmcpIHtcbiAgICBsZXQgaXNQb2ludGVyRmllbGQgPSBmYWxzZTtcbiAgICBwaXBlbGluZSA9IHBpcGVsaW5lLm1hcCgoc3RhZ2UpID0+IHtcbiAgICAgIGlmIChzdGFnZS4kZ3JvdXApIHtcbiAgICAgICAgc3RhZ2UuJGdyb3VwID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3Moc2NoZW1hLCBzdGFnZS4kZ3JvdXApO1xuICAgICAgICBpZiAoc3RhZ2UuJGdyb3VwLl9pZCAmJiAodHlwZW9mIHN0YWdlLiRncm91cC5faWQgPT09ICdzdHJpbmcnKSAmJiBzdGFnZS4kZ3JvdXAuX2lkLmluZGV4T2YoJyRfcF8nKSA+PSAwKSB7XG4gICAgICAgICAgaXNQb2ludGVyRmllbGQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJG1hdGNoKSB7XG4gICAgICAgIHN0YWdlLiRtYXRjaCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHN0YWdlLiRtYXRjaCk7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJHByb2plY3QpIHtcbiAgICAgICAgc3RhZ2UuJHByb2plY3QgPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZVByb2plY3RBcmdzKHNjaGVtYSwgc3RhZ2UuJHByb2plY3QpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHN0YWdlO1xuICAgIH0pO1xuICAgIHJlYWRQcmVmZXJlbmNlID0gdGhpcy5fcGFyc2VSZWFkUHJlZmVyZW5jZShyZWFkUHJlZmVyZW5jZSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uYWdncmVnYXRlKHBpcGVsaW5lLCB7IHJlYWRQcmVmZXJlbmNlLCBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyB9KSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxNjAwNikge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdC5oYXNPd25Qcm9wZXJ0eSgnX2lkJykpIHtcbiAgICAgICAgICAgIGlmIChpc1BvaW50ZXJGaWVsZCAmJiByZXN1bHQuX2lkKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5faWQgPSByZXN1bHQuX2lkLnNwbGl0KCckJylbMV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzdWx0Ll9pZCA9PSBudWxsIHx8IF8uaXNFbXB0eShyZXN1bHQuX2lkKSkge1xuICAgICAgICAgICAgICByZXN1bHQuX2lkID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IHJlc3VsdC5faWQ7XG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0Ll9pZDtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgIH0pXG4gICAgICAudGhlbihvYmplY3RzID0+IG9iamVjdHMubWFwKG9iamVjdCA9PiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiB3aWxsIHJlY3Vyc2l2ZWx5IHRyYXZlcnNlIHRoZSBwaXBlbGluZSBhbmQgY29udmVydCBhbnkgUG9pbnRlciBvciBEYXRlIGNvbHVtbnMuXG4gIC8vIElmIHdlIGRldGVjdCBhIHBvaW50ZXIgY29sdW1uIHdlIHdpbGwgcmVuYW1lIHRoZSBjb2x1bW4gYmVpbmcgcXVlcmllZCBmb3IgdG8gbWF0Y2ggdGhlIGNvbHVtblxuICAvLyBpbiB0aGUgZGF0YWJhc2UuIFdlIGFsc28gbW9kaWZ5IHRoZSB2YWx1ZSB0byB3aGF0IHdlIGV4cGVjdCB0aGUgdmFsdWUgdG8gYmUgaW4gdGhlIGRhdGFiYXNlXG4gIC8vIGFzIHdlbGwuXG4gIC8vIEZvciBkYXRlcywgdGhlIGRyaXZlciBleHBlY3RzIGEgRGF0ZSBvYmplY3QsIGJ1dCB3ZSBoYXZlIGEgc3RyaW5nIGNvbWluZyBpbi4gU28gd2UnbGwgY29udmVydFxuICAvLyB0aGUgc3RyaW5nIHRvIGEgRGF0ZSBzbyB0aGUgZHJpdmVyIGNhbiBwZXJmb3JtIHRoZSBuZWNlc3NhcnkgY29tcGFyaXNvbi5cbiAgLy9cbiAgLy8gVGhlIGdvYWwgb2YgdGhpcyBtZXRob2QgaXMgdG8gbG9vayBmb3IgdGhlIFwibGVhdmVzXCIgb2YgdGhlIHBpcGVsaW5lIGFuZCBkZXRlcm1pbmUgaWYgaXQgbmVlZHNcbiAgLy8gdG8gYmUgY29udmVydGVkLiBUaGUgcGlwZWxpbmUgY2FuIGhhdmUgYSBmZXcgZGlmZmVyZW50IGZvcm1zLiBGb3IgbW9yZSBkZXRhaWxzLCBzZWU6XG4gIC8vICAgICBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9vcGVyYXRvci9hZ2dyZWdhdGlvbi9cbiAgLy9cbiAgLy8gSWYgdGhlIHBpcGVsaW5lIGlzIGFuIGFycmF5LCBpdCBtZWFucyB3ZSBhcmUgcHJvYmFibHkgcGFyc2luZyBhbiAnJGFuZCcgb3IgJyRvcicgb3BlcmF0b3IuIEluXG4gIC8vIHRoYXQgY2FzZSB3ZSBuZWVkIHRvIGxvb3AgdGhyb3VnaCBhbGwgb2YgaXQncyBjaGlsZHJlbiB0byBmaW5kIHRoZSBjb2x1bW5zIGJlaW5nIG9wZXJhdGVkIG9uLlxuICAvLyBJZiB0aGUgcGlwZWxpbmUgaXMgYW4gb2JqZWN0LCB0aGVuIHdlJ2xsIGxvb3AgdGhyb3VnaCB0aGUga2V5cyBjaGVja2luZyB0byBzZWUgaWYgdGhlIGtleSBuYW1lXG4gIC8vIG1hdGNoZXMgb25lIG9mIHRoZSBzY2hlbWEgY29sdW1ucy4gSWYgaXQgZG9lcyBtYXRjaCBhIGNvbHVtbiBhbmQgdGhlIGNvbHVtbiBpcyBhIFBvaW50ZXIgb3JcbiAgLy8gYSBEYXRlLCB0aGVuIHdlJ2xsIGNvbnZlcnQgdGhlIHZhbHVlIGFzIGRlc2NyaWJlZCBhYm92ZS5cbiAgLy9cbiAgLy8gQXMgbXVjaCBhcyBJIGhhdGUgcmVjdXJzaW9uLi4udGhpcyBzZWVtZWQgbGlrZSBhIGdvb2QgZml0IGZvciBpdC4gV2UncmUgZXNzZW50aWFsbHkgdHJhdmVyc2luZ1xuICAvLyBkb3duIGEgdHJlZSB0byBmaW5kIGEgXCJsZWFmIG5vZGVcIiBhbmQgY2hlY2tpbmcgdG8gc2VlIGlmIGl0IG5lZWRzIHRvIGJlIGNvbnZlcnRlZC5cbiAgX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSk6IGFueSB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGlwZWxpbmUpKSB7XG4gICAgICByZXR1cm4gcGlwZWxpbmUubWFwKCh2YWx1ZSkgPT4gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgdmFsdWUpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBwaXBlbGluZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHBpcGVsaW5lKSB7XG4gICAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHBpcGVsaW5lW2ZpZWxkXSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIC8vIFBhc3Mgb2JqZWN0cyBkb3duIHRvIE1vbmdvREIuLi50aGlzIGlzIG1vcmUgdGhhbiBsaWtlbHkgYW4gJGV4aXN0cyBvcGVyYXRvci5cbiAgICAgICAgICAgIHJldHVyblZhbHVlW2BfcF8ke2ZpZWxkfWBdID0gcGlwZWxpbmVbZmllbGRdO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm5WYWx1ZVtgX3BfJHtmaWVsZH1gXSA9IGAke3NjaGVtYS5maWVsZHNbZmllbGRdLnRhcmdldENsYXNzfSQke3BpcGVsaW5lW2ZpZWxkXX1gO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnRGF0ZScpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9jb252ZXJ0VG9EYXRlKHBpcGVsaW5lW2ZpZWxkXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgcGlwZWxpbmVbZmllbGRdKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmaWVsZCA9PT0gJ29iamVjdElkJykge1xuICAgICAgICAgIHJldHVyblZhbHVlWydfaWQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAnY3JlYXRlZEF0Jykge1xuICAgICAgICAgIHJldHVyblZhbHVlWydfY3JlYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT09ICd1cGRhdGVkQXQnKSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbJ191cGRhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICAgIH1cbiAgICByZXR1cm4gcGlwZWxpbmU7XG4gIH1cblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIHNsaWdodGx5IGRpZmZlcmVudCB0aGFuIHRoZSBvbmUgYWJvdmUuIFJhdGhlciB0aGFuIHRyeWluZyB0byBjb21iaW5lIHRoZXNlXG4gIC8vIHR3byBmdW5jdGlvbnMgYW5kIG1ha2luZyB0aGUgY29kZSBldmVuIGhhcmRlciB0byB1bmRlcnN0YW5kLCBJIGRlY2lkZWQgdG8gc3BsaXQgaXQgdXAuIFRoZVxuICAvLyBkaWZmZXJlbmNlIHdpdGggdGhpcyBmdW5jdGlvbiBpcyB3ZSBhcmUgbm90IHRyYW5zZm9ybWluZyB0aGUgdmFsdWVzLCBvbmx5IHRoZSBrZXlzIG9mIHRoZVxuICAvLyBwaXBlbGluZS5cbiAgX3BhcnNlQWdncmVnYXRlUHJvamVjdEFyZ3Moc2NoZW1hOiBhbnksIHBpcGVsaW5lOiBhbnkpOiBhbnkge1xuICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307XG4gICAgZm9yIChjb25zdCBmaWVsZCBpbiBwaXBlbGluZSkge1xuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICByZXR1cm5WYWx1ZVtgX3BfJHtmaWVsZH1gXSA9IHBpcGVsaW5lW2ZpZWxkXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHBpcGVsaW5lW2ZpZWxkXSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChmaWVsZCA9PT0gJ29iamVjdElkJykge1xuICAgICAgICByZXR1cm5WYWx1ZVsnX2lkJ10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAnY3JlYXRlZEF0Jykge1xuICAgICAgICByZXR1cm5WYWx1ZVsnX2NyZWF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT09ICd1cGRhdGVkQXQnKSB7XG4gICAgICAgIHJldHVyblZhbHVlWydfdXBkYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gIH1cblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIHNsaWdodGx5IGRpZmZlcmVudCB0aGFuIHRoZSB0d28gYWJvdmUuIE1vbmdvREIgJGdyb3VwIGFnZ3JlZ2F0ZSBsb29rcyBsaWtlOlxuICAvLyAgICAgeyAkZ3JvdXA6IHsgX2lkOiA8ZXhwcmVzc2lvbj4sIDxmaWVsZDE+OiB7IDxhY2N1bXVsYXRvcjE+IDogPGV4cHJlc3Npb24xPiB9LCAuLi4gfSB9XG4gIC8vIFRoZSA8ZXhwcmVzc2lvbj4gY291bGQgYmUgYSBjb2x1bW4gbmFtZSwgcHJlZml4ZWQgd2l0aCB0aGUgJyQnIGNoYXJhY3Rlci4gV2UnbGwgbG9vayBmb3JcbiAgLy8gdGhlc2UgPGV4cHJlc3Npb24+IGFuZCBjaGVjayB0byBzZWUgaWYgaXQgaXMgYSAnUG9pbnRlcicgb3IgaWYgaXQncyBvbmUgb2YgY3JlYXRlZEF0LFxuICAvLyB1cGRhdGVkQXQgb3Igb2JqZWN0SWQgYW5kIGNoYW5nZSBpdCBhY2NvcmRpbmdseS5cbiAgX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55KTogYW55IHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShwaXBlbGluZSkpIHtcbiAgICAgIHJldHVybiBwaXBlbGluZS5tYXAoKHZhbHVlKSA9PiB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWEsIHZhbHVlKSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcGlwZWxpbmUgPT09ICdvYmplY3QnKSB7XG4gICAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBwaXBlbGluZSkge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWEsIHBpcGVsaW5lW2ZpZWxkXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcGlwZWxpbmUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBjb25zdCBmaWVsZCA9IHBpcGVsaW5lLnN1YnN0cmluZygxKTtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGAkX3BfJHtmaWVsZH1gO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PSAnY3JlYXRlZEF0Jykge1xuICAgICAgICByZXR1cm4gJyRfY3JlYXRlZF9hdCc7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09ICd1cGRhdGVkQXQnKSB7XG4gICAgICAgIHJldHVybiAnJF91cGRhdGVkX2F0JztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHBpcGVsaW5lO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiB3aWxsIGF0dGVtcHQgdG8gY29udmVydCB0aGUgcHJvdmlkZWQgdmFsdWUgdG8gYSBEYXRlIG9iamVjdC4gU2luY2UgdGhpcyBpcyBwYXJ0XG4gIC8vIG9mIGFuIGFnZ3JlZ2F0aW9uIHBpcGVsaW5lLCB0aGUgdmFsdWUgY2FuIGVpdGhlciBiZSBhIHN0cmluZyBvciBpdCBjYW4gYmUgYW5vdGhlciBvYmplY3Qgd2l0aFxuICAvLyBhbiBvcGVyYXRvciBpbiBpdCAobGlrZSAkZ3QsICRsdCwgZXRjKS4gQmVjYXVzZSBvZiB0aGlzIEkgZmVsdCBpdCB3YXMgZWFzaWVyIHRvIG1ha2UgdGhpcyBhXG4gIC8vIHJlY3Vyc2l2ZSBtZXRob2QgdG8gdHJhdmVyc2UgZG93biB0byB0aGUgXCJsZWFmIG5vZGVcIiB3aGljaCBpcyBnb2luZyB0byBiZSB0aGUgc3RyaW5nLlxuICBfY29udmVydFRvRGF0ZSh2YWx1ZTogYW55KTogYW55IHtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIG5ldyBEYXRlKHZhbHVlKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9XG4gICAgZm9yIChjb25zdCBmaWVsZCBpbiB2YWx1ZSkge1xuICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fY29udmVydFRvRGF0ZSh2YWx1ZVtmaWVsZF0pXG4gICAgfVxuICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgfVxuXG4gIF9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nKTogP3N0cmluZyB7XG4gICAgc3dpdGNoIChyZWFkUHJlZmVyZW5jZSkge1xuICAgIGNhc2UgJ1BSSU1BUlknOlxuICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5QUklNQVJZO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnUFJJTUFSWV9QUkVGRVJSRUQnOlxuICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5QUklNQVJZX1BSRUZFUlJFRDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ1NFQ09OREFSWSc6XG4gICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlNFQ09OREFSWTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ1NFQ09OREFSWV9QUkVGRVJSRUQnOlxuICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5TRUNPTkRBUllfUFJFRkVSUkVEO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnTkVBUkVTVCc6XG4gICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLk5FQVJFU1Q7XG4gICAgICBicmVhaztcbiAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ05vdCBzdXBwb3J0ZWQgcmVhZCBwcmVmZXJlbmNlLicpO1xuICAgIH1cbiAgICByZXR1cm4gcmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICBwZXJmb3JtSW5pdGlhbGl6YXRpb24oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY3JlYXRlSW5kZXgoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4OiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4KGluZGV4KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGNyZWF0ZUluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4ZXM6IGFueSkge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXhlcyhpbmRleGVzKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGNyZWF0ZUluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWU6IHN0cmluZywgZmllbGROYW1lOiBzdHJpbmcsIHR5cGU6IGFueSkge1xuICAgIGlmICh0eXBlICYmIHR5cGUudHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICBjb25zdCBpbmRleCA9IHtcbiAgICAgICAgW2ZpZWxkTmFtZV06ICcyZHNwaGVyZSdcbiAgICAgIH07XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVJbmRleChjbGFzc05hbWUsIGluZGV4KTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY3JlYXRlVGV4dEluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWU6IHN0cmluZywgcXVlcnk6IFF1ZXJ5VHlwZSwgc2NoZW1hOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBmb3IoY29uc3QgZmllbGROYW1lIGluIHF1ZXJ5KSB7XG4gICAgICBpZiAoIXF1ZXJ5W2ZpZWxkTmFtZV0gfHwgIXF1ZXJ5W2ZpZWxkTmFtZV0uJHRleHQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBleGlzdGluZ0luZGV4ZXMgPSBzY2hlbWEuaW5kZXhlcztcbiAgICAgIGZvciAoY29uc3Qga2V5IGluIGV4aXN0aW5nSW5kZXhlcykge1xuICAgICAgICBjb25zdCBpbmRleCA9IGV4aXN0aW5nSW5kZXhlc1trZXldO1xuICAgICAgICBpZiAoaW5kZXguaGFzT3duUHJvcGVydHkoZmllbGROYW1lKSkge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29uc3QgaW5kZXhOYW1lID0gYCR7ZmllbGROYW1lfV90ZXh0YDtcbiAgICAgIGNvbnN0IHRleHRJbmRleCA9IHtcbiAgICAgICAgW2luZGV4TmFtZV06IHsgW2ZpZWxkTmFtZV06ICd0ZXh0JyB9XG4gICAgICB9O1xuICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoY2xhc3NOYW1lLCB0ZXh0SW5kZXgsIGV4aXN0aW5nSW5kZXhlcywgc2NoZW1hLmZpZWxkcylcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIGlmIChlcnJvci5jb2RlID09PSA4NSkgeyAvLyBJbmRleCBleGlzdCB3aXRoIGRpZmZlcmVudCBvcHRpb25zXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzRnJvbU1vbmdvKGNsYXNzTmFtZSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgZ2V0SW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uaW5kZXhlcygpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZHJvcEluZGV4KGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleDogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5kcm9wSW5kZXgoaW5kZXgpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZHJvcEFsbEluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmRyb3BJbmRleGVzKCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICB1cGRhdGVTY2hlbWFXaXRoSW5kZXhlcygpOiBQcm9taXNlPGFueT4ge1xuICAgIHJldHVybiB0aGlzLmdldEFsbENsYXNzZXMoKVxuICAgICAgLnRoZW4oKGNsYXNzZXMpID0+IHtcbiAgICAgICAgY29uc3QgcHJvbWlzZXMgPSBjbGFzc2VzLm1hcCgoc2NoZW1hKSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc0Zyb21Nb25nbyhzY2hlbWEuY2xhc3NOYW1lKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcyk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IE1vbmdvU3RvcmFnZUFkYXB0ZXI7XG4iXX0=