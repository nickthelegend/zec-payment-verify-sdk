//! zpay-verify: check an incoming shielded Zcash payment with only the receiver's unified
//! *incoming* viewing key (UIVK).
//!
//! ```no_run
//! # async fn demo() -> Result<(), zpay_verify::VerifyError> {
//! use zpay_verify::{verify, Expect};
//! let v = verify("https://testnet.zec.rocks:443", "uivktest1…", "030c3cbf…",
//!                &Expect { amount_zat: 100_000, memo: Some("x402z-…".into()), min_conf: 1, shielded_only: true }).await?;
//! assert!(v.verdict.ok);
//! # Ok(()) }
//! ```
//!
//! The transaction is fetched from lightwalletd, its txid is re-computed, the compact block at the
//! height lightwalletd reports must list it, every proof and signature in it is verified against its
//! recomputed signature hash ([`auth`]), and every Sapling, Orchard and Ironwood output is
//! trial-decrypted with the key. The anchors, the transparent inputs' previous outputs and the block's
//! place in the chain are not checked: lightwalletd (or anyone who can answer for it) is trusted for
//! those (see [`auth`] for what that leaves open). An incoming viewing key sees
//! received notes and their memos; it cannot spend, and cannot see spends or change.
//! Extracted from zec-shielded-x402's facilitator `check_uivk` (same author, MIT).

pub mod auth;
pub mod lwd;

use orchard::note_encryption::{DomainVersion, IronwoodVersion, NoteEncryptionDomain, OrchardVersion};
use sapling::note_encryption::SaplingDomain;
use serde::Serialize;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedIncomingViewingKey};
use zcash_note_encryption::try_note_decryption;
use zcash_primitives::transaction::{components::sapling::zip212_enforcement, Transaction};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::TxId;

pub const NETWORK: Network = Network::TestNetwork;

/// Something went wrong before a verdict could be reached (bad input, network).
#[derive(Debug)]
pub enum VerifyError {
    BadKey(String),
    BadTxid(String),
    BadAddress(String),
    Lwd(lwd::LwdError),
    Unparseable(String),
    TxidMismatch,
    /// Lightwalletd's answers contradict each other (for example the block it names does not list the tx,
    /// or the transaction's proofs or signatures do not verify).
    Inconsistent(String),
    /// Something this machine needs is missing (the Sapling parameters for a Sapling transaction).
    Setup(String),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::BadKey(e) => write!(f, "not a testnet unified incoming viewing key: {e}"),
            VerifyError::BadTxid(t) => write!(f, "not a txid (64 hex characters): {t}"),
            VerifyError::BadAddress(a) => write!(f, "not a testnet unified address with a shielded receiver: {a}"),
            VerifyError::Lwd(e) => write!(f, "{e}"),
            VerifyError::Unparseable(e) => write!(f, "transaction does not parse: {e}"),
            VerifyError::TxidMismatch => write!(f, "lightwalletd returned a transaction whose txid differs from the one requested"),
            VerifyError::Inconsistent(e) => write!(f, "lightwalletd answered inconsistently: {e}"),
            VerifyError::Setup(e) => write!(f, "Setup required: {e}"),
        }
    }
}

impl std::error::Error for VerifyError {}

impl From<lwd::LwdError> for VerifyError {
    fn from(e: lwd::LwdError) -> Self {
        VerifyError::Lwd(e)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Output {
    pub pool: &'static str,
    pub value: u64,
    /// Text memo, if the memo is text.
    pub memo: Option<String>,
    /// The memo is set but is not UTF-8 text.
    pub memo_binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct Pools {
    pub sapling: bool,
    pub orchard: bool,
    pub ironwood: bool,
    pub transparent: bool,
}

/// What the viewing key sees in one transaction.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TxReport {
    pub txid: String,
    pub found: bool,
    /// None while in the mempool or when not found.
    pub height: Option<u32>,
    /// Unix time of that block, from lightwalletd's compact block. None while in the mempool or when not found.
    pub block_time: Option<u32>,
    pub confirmations: u32,
    pub tip: u32,
    pub outputs: Vec<Output>,
    pub pools: Pools,
}

/// What the receiver expects to have been paid.
#[derive(Debug, Clone)]
pub struct Expect {
    pub amount_zat: u64,
    /// Only outputs with exactly this text memo count. None: every output to the key counts.
    pub memo: Option<String>,
    pub min_conf: u32,
    /// Reject a transaction that has any transparent input or output.
    pub shielded_only: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Verdict {
    pub ok: bool,
    /// Sum of the outputs that count towards the payment.
    pub paid_zat: u64,
    /// Empty when ok. Codes: TX_NOT_FOUND, NO_OUTPUT_TO_KEY, MEMO_MISMATCH, AMOUNT_TOO_LOW,
    /// NOT_CONFIRMED, TRANSPARENT_PART.
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Verification {
    pub report: TxReport,
    pub verdict: Verdict,
    pub lightwalletd: String,
}

pub fn parse_uivk(s: &str) -> Result<UnifiedIncomingViewingKey, VerifyError> {
    UnifiedIncomingViewingKey::decode(&NETWORK, s.trim()).map_err(|e| VerifyError::BadKey(e.to_string()))
}

/// UFVK → UIVK, so a receiver can share a key that sees incoming payments only.
pub fn uivk_from_ufvk(ufvk: &str) -> Result<String, VerifyError> {
    let k = UnifiedFullViewingKey::decode(&NETWORK, ufvk.trim()).map_err(|e| VerifyError::BadKey(e.to_string()))?;
    k.to_unified_incoming_viewing_key().encode(&NETWORK).map_err(|e| VerifyError::BadKey(format!("{e:?}")))
}

/// Whether a unified address belongs to a viewing key, per shielded receiver (None: the address has no
/// receiver of that kind). Ironwood notes go to the Orchard receiver.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Ownership {
    /// Every shielded receiver in the address belongs to the key.
    pub owns: bool,
    pub orchard: Option<bool>,
    pub sapling: Option<bool>,
}

/// Does the unified address `ua` belong to `uivk`? Each shielded receiver's diversifier is decrypted with
/// the key and the address re-derived from it. Offline. A merchant runs this before advertising `ua`:
/// a payment to an address the key cannot see is a payment the checker can never accept.
pub fn owns(uivk: &UnifiedIncomingViewingKey, ua: &str) -> Result<Ownership, VerifyError> {
    let bad = || VerifyError::BadAddress(ua.trim().to_string());
    let u = match zcash_keys::address::Address::decode(&NETWORK, ua.trim()) {
        Some(zcash_keys::address::Address::Unified(u)) => u,
        _ => return Err(bad()),
    };
    let orchard = u.orchard().map(|a| uivk.orchard().as_ref().is_some_and(|k| k.diversifier_index(a).is_some()));
    let sapling = u.sapling().map(|a| uivk.sapling().as_ref().is_some_and(|k| k.decrypt_diversifier(a).is_some()));
    if orchard.is_none() && sapling.is_none() {
        return Err(bad());
    }
    Ok(Ownership { owns: orchard.unwrap_or(true) && sapling.unwrap_or(true), orchard, sapling })
}

fn memo_of(m: &[u8; 512]) -> (Option<String>, bool) {
    match MemoBytes::from_bytes(m).ok().and_then(|b| Memo::try_from(&b).ok()) {
        Some(Memo::Text(t)) => (Some(t.to_string()), false),
        Some(Memo::Empty) => (None, false),
        _ => (None, true),
    }
}

fn orchard_family<V: DomainVersion>(
    pool: &'static str,
    ivk: &orchard::keys::IncomingViewingKey,
    bundle: &orchard::bundle::Bundle<orchard::bundle::Authorized, zcash_protocol::value::ZatBalance>,
    out: &mut Vec<Output>,
) {
    let p = orchard::keys::PreparedIncomingViewingKey::new(ivk);
    for a in bundle.actions() {
        let d = NoteEncryptionDomain::<V>::for_action(a);
        if let Some((note, _, memo)) = try_note_decryption(&d, &p, a) {
            let (memo, memo_binary) = memo_of(&memo);
            out.push(Output { pool, value: note.value().inner(), memo, memo_binary });
        }
    }
}

/// Every Sapling, Orchard and Ironwood output of `tx` that decrypts to `uivk`, as of a block at `height`
/// (which decides the Sapling note plaintext rules). No network.
pub fn decrypt_outputs(tx: &Transaction, uivk: &UnifiedIncomingViewingKey, height: BlockHeight) -> Vec<Output> {
    let mut outputs = Vec::new();
    if let (Some(b), Some(ivk)) = (tx.sapling_bundle(), uivk.sapling()) {
        let d = SaplingDomain::new(zip212_enforcement(&NETWORK, height));
        let p = ivk.prepare();
        for o in b.shielded_outputs() {
            if let Some((note, _, memo)) = try_note_decryption(&d, &p, o) {
                let (memo, memo_binary) = memo_of(&memo);
                outputs.push(Output { pool: "Sapling", value: note.value().inner(), memo, memo_binary });
            }
        }
    }
    if let Some(ivk) = uivk.orchard() {
        if let Some(b) = tx.orchard_bundle() {
            orchard_family::<OrchardVersion>("Orchard", ivk, b, &mut outputs);
        }
        if let Some(b) = tx.ironwood_bundle() {
            orchard_family::<IronwoodVersion>("Ironwood", ivk, b, &mut outputs);
        }
    }
    outputs
}

// Shared by inspect and transparent-prevout reads, so both reject swapped transaction bytes.
fn parse_transaction(data: &[u8], branch: BranchId, requested: &TxId) -> Result<Transaction, VerifyError> {
    let tx = Transaction::read(data, branch).map_err(|e| VerifyError::Unparseable(e.to_string()))?;
    if tx.txid() != *requested {
        return Err(VerifyError::TxidMismatch);
    }
    Ok(tx)
}

/// Fetch `txid` and decrypt it with `uivk`. A txid lightwalletd does not know is reported with
/// `found: false`, not as an error.
pub async fn inspect(c: &mut lwd::Client, uivk: &UnifiedIncomingViewingKey, txid: &str, tip: BlockHeight) -> Result<TxReport, VerifyError> {
    let id = lwd::parse_txid(txid).ok_or_else(|| VerifyError::BadTxid(txid.to_string()))?;
    let empty = |found| TxReport { txid: txid.to_string(), found, height: None, block_time: None, confirmations: 0, tip: tip.into(), outputs: vec![], pools: Pools::default() };
    let (data, loc) = match lwd::get_transaction(c, &id).await? {
        lwd::FetchedTx::Found { data, location } => (data, location),
        lwd::FetchedTx::NotFound => return Ok(empty(false)),
    };
    let mined = match loc {
        lwd::TxLocation::Mined(h) => Some(h),
        lwd::TxLocation::Mempool => None,
        // Only on a fork that is not the main chain: as good as not found.
        lwd::TxLocation::Orphaned => return Ok(empty(false)),
    };
    let tx = parse_transaction(&data, BranchId::for_height(&NETWORK, mined.unwrap_or(tip + 1)), &id)?;
    let prevouts = prevouts(c, &tx, tip).await?;
    authorized(&tx, &prevouts)?;
    let shielded = tx.sapling_bundle().is_some() || tx.orchard_bundle().is_some() || tx.ironwood_bundle().is_some();
    let block_time = match mined {
        Some(h) => {
            let block = lwd::get_block(c, h).await?;
            // Compact blocks list only transactions with a shielded part; one without has nothing to decrypt.
            Some(if shielded { check_inclusion(&block, h, &id).map_err(VerifyError::Inconsistent)? } else { block_at(&block, h).map_err(VerifyError::Inconsistent)? })
        }
        None => None,
    };
    let outputs = decrypt_outputs(&tx, uivk, mined.unwrap_or(tip + 1));
    let transparent = tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty() || !b.vout.is_empty());
    Ok(TxReport {
        txid: txid.to_string(),
        found: true,
        height: mined.map(u32::from),
        block_time,
        confirmations: mined.map(|h| u32::from(tip).saturating_sub(u32::from(h)) + 1).unwrap_or(0),
        tip: tip.into(),
        outputs,
        pools: Pools { sapling: tx.sapling_bundle().is_some(), orchard: tx.orchard_bundle().is_some(), ironwood: tx.ironwood_bundle().is_some(), transparent },
    })
}

/// What each transparent input of `tx` spends, fetched from the same lightwalletd (the shielded signature
/// hash commits to their amounts and scripts). Empty for a transaction without transparent inputs.
pub async fn prevouts(c: &mut lwd::Client, tx: &Transaction, tip: BlockHeight) -> Result<Vec<transparent::bundle::TxOut>, VerifyError> {
    let mut out = Vec::new();
    for input in tx.transparent_bundle().filter(|b| !b.is_coinbase()).map_or(&[][..], |b| &b.vin[..]) {
        let p = input.prevout();
        let id = TxId::from_bytes(*p.hash());
        let (data, loc) = match lwd::get_transaction(c, &id).await? {
            lwd::FetchedTx::Found { data, location } => (data, location),
            lwd::FetchedTx::NotFound => return Err(VerifyError::Inconsistent(format!("a transparent input spends {id}:{}, which it does not have", p.n()))),
        };
        let h = match loc {
            lwd::TxLocation::Mined(h) => h,
            _ => tip + 1,
        };
        let prev = parse_transaction(&data, BranchId::for_height(&NETWORK, h), &id)?;
        let o = prev.transparent_bundle().and_then(|b| b.vout.get(p.n() as usize)).ok_or_else(|| VerifyError::Inconsistent(format!("a transparent input spends {id}:{}, which has no such output", p.n())))?;
        out.push(o.clone());
    }
    Ok(out)
}

/// [`auth::check_authorization`] as a [`VerifyError`]: proofs or signatures that do not verify mean the
/// server handed over a transaction consensus would reject.
pub fn authorized(tx: &Transaction, prevouts: &[transparent::bundle::TxOut]) -> Result<(), VerifyError> {
    auth::check_authorization(tx, prevouts).map_err(|e| match e {
        auth::AuthError::Invalid(m) => VerifyError::Inconsistent(format!("the transaction's proofs or signatures do not verify: {m}")),
        auth::AuthError::Setup(m) => VerifyError::Setup(m),
    })
}

fn block_at(block: &CompactBlock, h: BlockHeight) -> Result<u32, String> {
    if block.height != u64::from(u32::from(h)) {
        return Err(format!("asked for block {h}, got block height {}", block.height));
    }
    Ok(block.time)
}

/// The compact block lightwalletd serves for height `h` must be that height and list `txid`; returns the
/// block's time. Catches a server (or an interceptor) that names a height for a transaction it did not
/// put in that block. A server willing to forge the block too is not caught: see the trust model.
pub fn check_inclusion(block: &CompactBlock, h: BlockHeight, txid: &TxId) -> Result<u32, String> {
    let t = block_at(block, h)?;
    if !block.vtx.iter().any(|tx| tx.txid.as_slice() == txid.as_ref()) {
        return Err(format!("it says {txid} was mined at height {h}, but its block at {h} does not list it"));
    }
    Ok(t)
}

/// The rules, separate from the network so they can be read and tested on their own.
pub fn check(r: &TxReport, e: &Expect) -> Verdict {
    let mut reasons = Vec::new();
    if !r.found {
        return Verdict { ok: false, paid_zat: 0, reasons: vec!["TX_NOT_FOUND".into()] };
    }
    let counted: Vec<&Output> = r.outputs.iter().filter(|o| e.memo.as_ref().is_none_or(|m| o.memo.as_deref() == Some(m.as_str()))).collect();
    let paid_zat = counted.iter().map(|o| o.value).sum();
    if r.outputs.is_empty() {
        reasons.push("NO_OUTPUT_TO_KEY".into());
    } else if counted.is_empty() {
        reasons.push("MEMO_MISMATCH".into());
    }
    if !r.outputs.is_empty() && paid_zat < e.amount_zat {
        reasons.push("AMOUNT_TOO_LOW".into());
    }
    if r.confirmations < e.min_conf {
        reasons.push("NOT_CONFIRMED".into());
    }
    if e.shielded_only && r.pools.transparent {
        reasons.push("TRANSPARENT_PART".into());
    }
    Verdict { ok: reasons.is_empty(), paid_zat, reasons }
}

/// Connect, fetch, decrypt, check. Default connection options: no proxy, plaintext only to loopback.
pub async fn verify(lwd_url: &str, uivk: &str, txid: &str, e: &Expect) -> Result<Verification, VerifyError> {
    verify_with(lwd_url, &lwd::ConnectOptions::default(), uivk, txid, e).await
}

/// [`verify`] with explicit connection options (a SOCKS5 proxy, plaintext to a remote host).
pub async fn verify_with(lwd_url: &str, o: &lwd::ConnectOptions, uivk: &str, txid: &str, e: &Expect) -> Result<Verification, VerifyError> {
    let key = parse_uivk(uivk)?;
    let mut c = lwd::connect_with(lwd_url, o).await?;
    let tip = lwd::chain_tip(&mut c).await?;
    let report = inspect(&mut c, &key, txid, tip).await?;
    let verdict = check(&report, e);
    Ok(Verification { report, verdict, lightwalletd: lwd_url.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(outputs: Vec<(u64, Option<&str>)>, conf: u32, transparent: bool) -> TxReport {
        TxReport {
            txid: "00".repeat(32),
            found: true,
            height: Some(100),
            block_time: Some(1_792_500_000),
            confirmations: conf,
            tip: 100 + conf.saturating_sub(1),
            outputs: outputs.into_iter().map(|(value, m)| Output { pool: "Ironwood", value, memo: m.map(String::from), memo_binary: false }).collect(),
            pools: Pools { ironwood: true, transparent, ..Pools::default() },
        }
    }
    const E: fn(u64, Option<&str>) -> Expect = |amount_zat, memo| Expect { amount_zat, memo: memo.map(String::from), min_conf: 1, shielded_only: true };

    #[tokio::test]
    async fn recorded_transaction_bytes_cannot_be_swapped_for_another_requested_txid() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/testnet.json")).unwrap();
        let wanted = lwd::parse_txid(fixture["x402"]["txid"].as_str().unwrap()).unwrap();
        let other = lwd::parse_txid(fixture["auction"]["deposit"]["txid"].as_str().unwrap()).unwrap();
        let mut client = lwd::connect(lwd::DEFAULT_LWD_URL).await.unwrap();
        for id in [wanted, other] {
            let lwd::FetchedTx::Found { data, location: lwd::TxLocation::Mined(h) } = lwd::get_transaction(&mut client, &id).await.unwrap() else { panic!("recorded transaction must be mined") };
            let branch = BranchId::for_height(&NETWORK, h);
            assert_eq!(parse_transaction(&data, branch, &id).unwrap().txid(), id);
            let swapped = if id == wanted { other } else { wanted };
            let err = parse_transaction(&data, branch, &swapped).unwrap_err();
            assert!(matches!(err, VerifyError::TxidMismatch));
            assert_eq!(err.to_string(), "lightwalletd returned a transaction whose txid differs from the one requested");
        }
    }

    #[test]
    fn exact_payment_passes_and_counts_only_matching_memos() {
        let r = report(vec![(60, Some("inv-1")), (40, Some("inv-1")), (500, Some("other"))], 3, false);
        assert_eq!(check(&r, &E(100, Some("inv-1"))), Verdict { ok: true, paid_zat: 100, reasons: vec![] });
        assert_eq!(check(&r, &E(101, Some("inv-1"))).reasons, vec!["AMOUNT_TOO_LOW"]);
        assert_eq!(check(&r, &E(600, None)).paid_zat, 600);
    }

    #[test]
    fn each_failure_has_its_reason() {
        assert_eq!(check(&report(vec![], 3, false), &E(1, None)).reasons, vec!["NO_OUTPUT_TO_KEY"]);
        assert_eq!(check(&report(vec![(100, Some("a"))], 3, false), &E(100, Some("b"))).reasons, vec!["MEMO_MISMATCH", "AMOUNT_TOO_LOW"]);
        assert_eq!(check(&report(vec![(100, None)], 0, false), &E(100, None)).reasons, vec!["NOT_CONFIRMED"]);
        assert_eq!(check(&report(vec![(100, None)], 2, true), &E(100, None)).reasons, vec!["TRANSPARENT_PART"]);
        let mut gone = report(vec![], 0, false);
        gone.found = false;
        assert_eq!(check(&gone, &E(1, None)).reasons, vec!["TX_NOT_FOUND"]);
    }

    #[test]
    fn transparent_allowed_when_asked() {
        let e = Expect { shielded_only: false, ..E(100, None) };
        assert!(check(&report(vec![(100, None)], 2, true), &e).ok);
    }
}
