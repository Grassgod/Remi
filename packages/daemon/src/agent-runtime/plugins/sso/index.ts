/**
 * src/plugins/sso — self-contained SSO package.
 *
 * Public surface (only export what consumers need; everything else is internal).
 */

export { SsoPlugin, type SsoPluginOptions } from "./plugin.js";
export type { SsoVariables } from "./http/middleware.js";

// Provider plugin contract — for users writing their own provider plugins
export type {
  SsoProvider,
  SsoProviderFactory,
  AuthorizeParams,
  AuthorizedClaims,
  PluginTypeMeta,
  ConfigField,
} from "./providers/base.js";

// Built-in providers (re-exported for convenience)
export {
  BytedanceOidcProvider,
  BYTEDANCE_OIDC_META,
} from "./providers/bytedance-oidc.js";
export {
  GenericOidcProvider,
  GENERIC_OIDC_META,
} from "./providers/generic-oidc.js";

// DB types consumers may want to read (e.g. to list users in admin UI later)
export type { User, UserSession } from "./db/users.js";
export { listUsers, getUserByUsername } from "./db/users.js";
export { listProviders, getProvider } from "./db/providers.js";
export type { SsoProviderRow } from "./db/providers.js";
export {
  listClusters,
  getDefaultCluster,
  type ClusterRow,
} from "./db/clusters.js";
export { getSettings, updateSettings } from "./db/settings.js";
