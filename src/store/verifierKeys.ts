/** The verifier page's text keys, apart from the page itself so the plugin can name them without carrying the page's script. */
/** Every line of text the page shows; `ui/copy.ts` (group `verifier`) holds the English, the caller passes it in. */
export const VERIFIER_KEYS = [
  "title", "intro", "offline", "chooseFiles", "chooseFolder", "nothing", "unreadable", "noCrypto", "unknownKind",
  "headlineOk", "headlineBad", "dateConfirmed", "datePending", "dateSealed",
  "l_textHash_ok", "l_textHash_bad", "l_path_ok", "l_path_bad", "l_leaf_na",
  "l_blockHash_ok", "l_blockHash_bad", "l_signature_ok", "l_signature_bad", "l_signature_na", "l_unsigned_na",
  "l_links_ok", "l_links_bad", "l_salt_ok", "l_salt_bad", "l_digest_ok", "l_digest_bad",
  "l_bitcoin_ok", "l_bitcoin_bad", "l_bitcoin_na", "l_noStamp_na", "l_ots_bad",
  "l_chainLinks_ok", "l_chainLinks_bad", "l_chainHashes_ok", "l_chainHashes_bad", "l_chainSigs_ok", "l_chainSigs_bad", "l_chainSigs_na",
  "l_files_ok", "l_files_bad", "l_files_na", "l_inclusion_ok", "l_inclusion_bad", "l_inclusion_na", "l_roots_ok", "l_roots_bad", "l_rowText_bad",
  "l_noChain_na",
  "readmeProof", "readmeAudit", "readmeExport", "mdNoDate", "mdEdited",
] as const;
export type VerifierKey = (typeof VERIFIER_KEYS)[number];
export type VerifierStrings = Readonly<Record<VerifierKey, string>>;
