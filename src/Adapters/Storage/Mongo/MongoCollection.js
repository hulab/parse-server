const AWSXRay = require('hulab-xray-sdk');
const mongodb = require('mongodb');
const Collection = mongodb.Collection;

export default class MongoCollection {
  _mongoCollection: Collection;

  constructor(mongoCollection: Collection) {
    this._mongoCollection = mongoCollection;
  }

  // Does a find with "smart indexing".
  // Currently this just means, if it needs a geoindex and there is
  // none, then build the geoindex.
  // This could be improved a lot but it's not clear if that's a good
  // idea. Or even if this behavior is a good idea.
  find(
    query,
    {
      skip,
      limit,
      sort,
      keys,
      maxTimeMS,
      readPreference,
      hint,
      caseInsensitive,
      explain,
    } = {}
  ) {
    // Support for Full Text Search - $text
    if (keys && keys.$score) {
      delete keys.$score;
      keys.score = { $meta: 'textScore' };
    }

    return this._executeWithTrace(
      'find',
      this._rawFind(query, {
        skip,
        limit,
        sort,
        keys,
        maxTimeMS,
        readPreference,
        hint,
        caseInsensitive,
        explain,
      }), query
    ).catch(error => {
      // Check for "no geoindex" error
      if (
        error.code != 17007 &&
        !error.message.match(/unable to find index for .geoNear/)
      ) {
        throw error;
      }
      // Figure out what key needs an index
      const key = error.message.match(/field=([A-Za-z_0-9]+) /)[1];
      if (!key) {
        throw error;
      }

      var index = {};
      index[key] = '2d';
      return (
        this._mongoCollection
          .createIndex(index)
          // Retry, but just once.
          .then(() =>
            this._executeWithTrace(
              'find',
              this._rawFind(query, {
                skip,
                limit,
                sort,
                keys,
                maxTimeMS,
                readPreference,
                hint,
                caseInsensitive,
                explain,
              })
            )
          )
      );
    });
  }

  /**
   * Collation to support case insensitive queries
   */
  static caseInsensitiveCollation() {
    return { locale: 'en_US', strength: 2 };
  }

  _rawFind(
    query,
    {
      skip,
      limit,
      sort,
      keys,
      maxTimeMS,
      readPreference,
      hint,
      caseInsensitive,
      explain,
    } = {}
  ) {
    let findOperation = this._mongoCollection.find(query, {
      skip,
      limit,
      sort,
      readPreference,
      hint,
    });

    if (keys) {
      findOperation = findOperation.project(keys);
    }

    if (caseInsensitive) {
      findOperation = findOperation.collation(
        MongoCollection.caseInsensitiveCollation()
      );
    }

    if (maxTimeMS) {
      findOperation = findOperation.maxTimeMS(maxTimeMS);
    }

    return explain ? findOperation.explain(explain) : findOperation.toArray();
  }

  count(query, { skip, limit, sort, maxTimeMS, readPreference, hint } = {}) {
    // If query is empty, then use estimatedDocumentCount instead.
    // This is due to countDocuments performing a scan,
    // which greatly increases execution time when being run on large collections.
    // See https://github.com/Automattic/mongoose/issues/6713 for more info regarding this problem.
    if (typeof query !== 'object' || !Object.keys(query).length) {
      return this._executeWithTrace(
        'estimatedDocumentCount',
        this._mongoCollection.estimatedDocumentCount({
          maxTimeMS,
        })
      );
    }

    const countOperation = this._executeWithTrace(
      'countDocuments',
      this._mongoCollection.countDocuments(query, {
        skip,
        limit,
        sort,
        maxTimeMS,
        readPreference,
        hint,
      })
    );

    return countOperation;
  }

  distinct(field, query) {
    return this._executeWithTrace(
      'distinct',
      this._mongoCollection.distinct(field, query)
    );
  }

  aggregate(pipeline, { maxTimeMS, readPreference, hint, explain } = {}) {
    return this._executeWithTrace(
      'aggregate',
      this._mongoCollection
        .aggregate(pipeline, { maxTimeMS, readPreference, hint, explain })
        .toArray()
    );
  }

  insertOne(object, session) {
    return this._executeWithTrace(
      'insertOne',
      this._mongoCollection.insertOne(object, { session })
    );
  }

  insertMany(object, session) {
    return this._executeWithTrace(
      'insertMany',
      this._mongoCollection.insertMany(object, { session })
    );
  }

  // Atomically updates data in the database for a single (first) object that matched the query
  // If there is nothing that matches the query - does insert
  // Postgres Note: `INSERT ... ON CONFLICT UPDATE` that is available since 9.5.
  upsertOne(query, update, session) {
    return this._executeWithTrace(
      'upsertOne',
      this._mongoCollection.updateOne(query, update, {
        upsert: true,
        session,
      })
    );
  }

  updateOne(query, update) {
    return this._executeWithTrace(
      'updateOne',
      this._mongoCollection.updateOne(query, update)
    );
  }

  updateMany(query, update, session) {
    return this._executeWithTrace(
      'updateMany',
      this._mongoCollection.updateMany(query, update, { session })
    );
  }

  deleteMany(query, session) {
    return this._executeWithTrace(
      'deleteMany',
      this._mongoCollection.deleteMany(query, { session })
    );
  }

  bulkWrite(operations, session) {
    return this._executeWithTrace(
      'bulkwrite',
      this._mongoCollection.bulkWrite(operations, { ordered: false, session })
    );
  }

  _ensureSparseUniqueIndexInBackground(indexRequest) {
    return new Promise((resolve, reject) => {
      this._mongoCollection.createIndex(
        indexRequest,
        { unique: true, background: true, sparse: true },
        error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }

  drop() {
    return this._mongoCollection.drop();
  }

  _executeWithTrace(type, fn, query) {
    const parent = AWSXRay.getSegment();
    if (!parent) {
      return fn;
    }
    return new Promise((resolve, reject) => {
      AWSXRay.captureAsyncFunc(`MongoDB Atlas`, subsegment => {
        try {
          subsegment && subsegment.addAttribute('namespace', 'aws');
          subsegment.addAttribute('aws', {region: process.env.AWS_REGION, database: 'mapstr', operation: `${type.toUpperCase()} ${this._mongoCollection.collectionName}`, type, collection: this._mongoCollection.collectionName, retries: 0});
          subsegment && subsegment.addAnnotation('Collection', this._mongoCollection.collectionName);
          subsegment && subsegment.addAnnotation('Operation', type);
          if (query && typeof query === "object") {
            subsegment && subsegment.addMetadata('Query', JSON.stringify(query));
          }
        } catch (error) {
          //
        }
        fn.then(
          function(result) {
            resolve(result);
            subsegment && subsegment.addAttribute('http', {response: {status: 200}});
            subsegment && subsegment.close();
          },
          function(error) {
            reject(error);
            subsegment && subsegment.close(error);
          }
        );
      });
    });
  }
}
