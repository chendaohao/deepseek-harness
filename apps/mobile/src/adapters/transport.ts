/**
 * Transport assembly (compat re-export): the paired host record plus
 * expo/fetch. New code should import {@link createApi} from `../lib/api.ts`
 * directly; this alias keeps existing call sites unchanged.
 */

export { createApi as createClient } from '../lib/api'
