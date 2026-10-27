# HULAB : Parse Server 9.10.7 / driver mongodb 7.7.0

## Références et périmètre

- Checkout principal initial propre : `patched/9.9.0-1`, `68e6444002f354399e73ae97523f612af24ac621`.
- Base fonctionnelle retenue : `b8852aa07ecb909736182ee6d43bb0c72555a13f`, branche HULAB `codex/patched-9.10.0-1`. Les 206 fichiers `lib` installés dans le backend sont identiques à ce commit ; son package indique bien 9.10.0.
- Base upstream de ce fork : tag `9.10.0`, `b5ca12fa5e2c951e0cd4ac45ec11e23430da323b`.
- Cible upstream : tag `9.10.7`, `9805d3e8f3ceb92683a2c2f874287573c0956683`, vérifié sur le remote officiel le 27 octobre 2026.
- Résultat local sur `codex/patched-9.10.7-1`, créée depuis le commit consommé, dans le même checkout. Intégration par squash, sans commit. Les anciennes branches sont conservées.
- Driver Node.js `mongodb` exactement **7.7.0** ; aucune migration de MongoDB Server.
- Aucun changement du backend consommateur, aucune connexion de production, aucun push, déploiement ou publication.

Sources officielles : [Parse Server 9.10.7](https://github.com/parse-community/parse-server/releases/tag/9.10.7), [driver 7.7.0](https://github.com/mongodb/node-mongodb-native/releases/tag/v7.7.0).

## Inventaire HULAB préservé

Le diff fonctionnel du commit consommé contre upstream 9.10.0 porte sur les 12 fichiers source suivants. Leur diff contre 9.10.7 a été relu après intégration. Une comparaison automatisée des lignes ajoutées/supprimées confirme que les 12 patches HULAB sont identiques à ceux du commit consommé ; seuls les contextes upstream évoluent.

| Chemin | Comportement conservé |
| --- | --- |
| `Adapters/Cache/CacheAdapter`, `InMemoryCacheAdapter`, `LRUCache` | Nettoyage limité au préfixe demandé ; séparation entre applications et sous-caches. |
| `Adapters/Cache/RedisCacheAdapter` | `SCAN` / `UNLINK`, échappement des caractères glob ; aucun `FLUSHDB` pour un nettoyage par préfixe. |
| `Controllers/CacheController` | Préfixes application / sous-cache transmis aux adaptateurs. |
| `Adapters/Storage/Mongo/MongoCollection` | `insertMany`, session transmise ; retour direct du count. |
| `Adapters/Storage/Mongo/MongoStorageAdapter` | `createObjects`, `updateObjectsByBulk`, transformations Parse/Mongo, bulk non ordonné et acquitté (`w: 1`), erreurs de doublon normalisées ; expressions Date d'agrégation préservées. |
| `RestWrite` | Invalidation ciblée du cache de rôles pour les membres modifiés ; invalidation large conservée pour les autres modifications de rôle. |
| `Routers/FunctionsRouter` | Instrumentation OpenTelemetry, nettoyage et bornage des paramètres de trace, prise en charge Date/RegExp/ObjectId/BigInt dans les logs, logs sur une ligne et normalisation des erreurs Cloud. |
| `middlewares` | Clé Redis distincte par règle de rate limit, fondée sur la route, les méthodes, la fenêtre, le seuil, la zone et les options. |
| `triggers` | Logs de triggers sur une ligne. |
| `Adapters/Files/GridFSBucketAdapter` | Annotation Flow supprimée pour maintenir le build généré propre. |

Les chemins de requête et de sérialisation du commit consommé ne portent pas d'autre divergence contre upstream 9.10.0. Les tests existants couvrent notamment les résultats JSON, les triggers et le mode direct. Les fichiers `lib` sont reconstruits à partir des sources. La compilation TypeScript passe ; les déclarations publiées sont conservées telles qu’upstream pour ne pas durcir la signature publique de `promiseRouter` à cause de la génération TypeScript.

## Intégration upstream

Tous les changements upstream 9.10.0 → 9.10.7 sont intégrés, avec leurs tests et dépendances, dont les protections ACL/CLP, des réponses de création/sauvegarde, des clés en dot notation, des sessions, de LiveQuery et du rate limit. En particulier :

- validation d'email sans backtracking pré-authentification (GHSA-9492-427f-466x) ;
- réponses de sauvegarde ne révélant pas les champs stockés aux appelants sans droit de lecture (GHSA-ch64-8phh-m7hc) ;
- suppression de la lecture DB additionnelle à la sauvegarde, avec permissions déterminées à partir du résultat de l'écriture ;
- correction des logs de vérification d'accès à la réponse ;
- correction des TTL par entrée du cache mémoire, combinée au nettoyage HULAB par préfixe ;
- détection des appels internes par socket et absence de `X-Forwarded-For`, combinée au préfixe Redis HULAB par règle.

Les conflits étaient limités à `package.json`, `package-lock.json` et à l'insertion de la fonction de rate limit dans `middlewares`. Aucun patch HULAB de permissions ou de sauvegarde n'a été remplacé par le fichier upstream entier.

## SDK Parse et dépendances

Le SDK top-level reste **HULAB 8.6.0**, ref `patched/8.6.0-1`, commit verrouillé `4aed39ffb4c013979d575c7f62190fa5a5a97d17`. Pas de substitution par npm public. Les trois sources patchées HULAB (`encode`, `ObjectStateMutations`, `IndexedDBStorageController`) restent celles de ce commit.

La comparaison officielle SDK 8.6.0 → 8.6.2 ne contient aucun changement de source, seulement dépendances, lockfile et changelogs : la mise à jour du code du SDK n'est pas nécessaire à cette intégration. Le push-adapter upstream peut avoir sa propre copie npm 8.6.2 ; elle ne remplace pas le SDK top-level utilisé par Parse Server.

Le SDK HULAB impose toutefois `ws` 8.20.0, alors qu'upstream 8.6.2 utilise 8.21.3. Un override limité à **`ws@8.20.0` → `8.21.3`** conserve le code HULAB tout en évitant les deux alertes ws de cette ancienne version. Les autres versions de ws ne sont pas ciblées. Aucun changement du checkout du SDK.

## Validation

Environnement : Node 24.14.1 ; MongoDB Server 8.0.16 standalone et Redis 7.4.2 compilé localement, uniquement sur loopback, données et logs dans `/private/tmp/parse-server-9.10.7-services`. Aucun `.prod.env` chargé. Les instances sont arrêtées après validation.

Résultats des exécutions et limites :

- `npm install --ignore-scripts --no-audit --no-fund`, puis résolution ciblée de ws : dépendances installées, SDK HULAB conservé ; `npm ls ws parse mongodb --depth=2` valide l'arbre final (ws 8.21.3 dédupliqué pour le SDK, driver 7.7.0).
- `npm run build` : 197 fichiers Babel compilés.
- `npm run build:types` : succès. Les deux déclarations générées qui divergeaient de la release officielle ont ensuite été remises à leur contenu upstream pour éviter un changement de signature non demandé.
- ESLint : succès sur les 12 fichiers source HULAB et sur les deux fichiers de tests complétés.
- `node --check` : succès sur les tests complétés et les fichiers générés contrôlés ; `git diff --check` sans erreur.
- Première série ciblée (cache Redis activé) : **582 tests exécutés, aucun échec, 4 cas désactivés par la suite existante**. Fichiers : `MongoCollection`, `MongoStorageAdapter`, `ParseQuery.Aggregate`, `CacheController`, `InMemoryCacheAdapter`, `RedisCacheAdapter`, `ParseRole`, `RateLimit`, `CloudCodeLogger`, `CloudCode`.
- Série large complémentaire (`vulnerabilities`, ACL, permissions par pointeur, RestQuery, MongoStorageAdapter) : interrompue après apparition de délais et erreurs HTTP en cascade sous une charge machine mesurée à 657. Les nouveaux tests bulk ont passé pendant cette série. Le test `find succeeds when query is within maxTimeMS` avait passé dans la première série puis a échoué sur son délai de 250 ms dans celle-ci, avec une erreur secondaire du helper `done.fail`. Cette série n'est pas une validation complète, et ses échecs ne sont pas qualifiés de préexistants sans reproduction indépendante.
- Sélection finale après alignement ws : **96 tests exécutés, aucun échec**, 1 025 cas hors sélection. Elle couvre GHSA-9492-427f-466x, GHSA-ch64-8phh-m7hc, les bulk writes HULAB, le JSON Cloud typé, les abonnements LiveQuery avec ACL et changement de rôle, ainsi que les cas fonctionnels affectés par les délais dans la série large. Timeout général porté à 60 s sans modification des assertions. Le test de délai Mongo à 250 ms n’est pas inclus dans cette relance. Un premier lancement a échoué pendant le `beforeAll` sur l'état de la base laissé par la série interrompue ; seule la base de tests locale a été vidée avant la relance.

Les tests ajoutés renforcent les compteurs et les données des bulk writes, les transformations Pointer/Date, les doublons et le contrat JSON Cloud (`__type`, `className`, `objectId`, décodage SDK).

## Risques et limites

- Le diff conserve les patches ; les tests ne constituent pas une preuve d'absence de toute régression.
- La suite complète et les transactions sur replica set ne sont pas validées. Aucun test PostgreSQL, authentification distante, push réel ou exporteur OpenTelemetry réel n'a été exécuté.
- La charge machine rend les mesures de performance et les assertions de délai strictes non concluantes ; aucun gain de latence n'est revendiqué.
- Audit runtime final : **21 alertes npm (10 modérées, 10 hautes, 1 critique)**, mêmes noms de paquets et mêmes totaux que le lockfile officiel 9.10.7 audité séparément. L'alerte critique concerne `proxy-addr` (< 2.0.8, GHSA-jqcg-44mw-7w3h). Ces alertes upstream ne sont pas corrigées dans ce chantier ; le résultat n'est pas présenté comme exempt de vulnérabilités. Les alertes supplémentaires `parse` / `ws` du SDK HULAB 8.6.0 ont disparu après l'override.
- L'intégration dans le backend consommateur et sa validation restent une étape distincte ; sa référence à `b8852aa…` est inchangée.

Logs locaux : `/private/tmp/parse-server-9.10.7-{targeted,security,final,build,types,lint,final-lint}.log`, audits `*-audit.json`, arbre final `*-final-dependencies.log`. Les artefacts temporaires ne sont pas suivis dans Git.

## Revalidation du 27 octobre 2026 après baisse de charge

La sélection élargie précédemment interrompue a été relancée avec le timeout par défaut, une base locale neuve, MongoDB Server 8.0.16 standalone, le driver mongodb 7.7.0 et Node 24.14.1 :

- `spec/vulnerabilities.spec.js`
- `spec/ParseACL.spec.js`
- `spec/PointerPermissions.spec.js`
- `spec/RestQuery.spec.js`
- `spec/MongoStorageAdapter.spec.js`

**894 tests exécutés, aucun échec, 25 cas désactivés par la suite existante**, en 2 min 6 s ; seed `35601`. Le test de requête sous `maxTimeMS` et le rejet de modification de `_failed_login_count`, qui avaient échoué lors de la série sous forte charge, passent dans cette exécution. Le diff source, lib, tests et dépendances est identique avant/après l'exécution (comparaison des patches). Aucun changement de code pendant cette revalidation ; seul ce bilan est complété.

Cette sélection élargie est donc désormais validée. Les limites relatives à la suite complète du projet, aux transactions sur replica set, aux intégrations distantes et aux alertes npm restent applicables. Aucun gain de performance n'est déduit de ce résultat.

L'instance MongoDB temporaire est arrêtée après les tests. Log : `/private/tmp/parse-server-revalidation-20261027/security.log` ; snapshot exact du diff testé : `/private/tmp/parse-server-revalidation-20261027/tested.patch`. Aucune connexion de production, aucun commit, push ou déploiement.
