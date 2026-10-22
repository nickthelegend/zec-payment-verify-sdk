//! Proofs and signatures: is this transaction authorized the way consensus requires?
//!
//! Every Orchard and Ironwood bundle's Halo 2 proof, spend authorization signatures and binding
//! signature, and every Sapling bundle's Groth16 proofs, spend authorization signatures and binding
//! signature, are checked against the transaction's shielded signature hash (ZIP 244), recomputed here
//! from the transaction itself. A transaction whose notes or values were altered, or one made up without
//! valid proofs and signatures, fails.
//!
//! What this does not check, and so still rests on the lightwalletd that served the transaction: that
//! the anchors (note commitment tree roots) the spends prove against are real roots of the chain, that
//! transparent inputs spend real unspent outputs (their amounts and scripts are fetched from the same
//! server), that the nullifiers are unspent, and the block it is said to be in. A server willing to run
//! a prover over a fake tree, or to invent a transparent input, can still make a transaction that
//! passes; it can no longer hand over one with garbled or missing proofs.

use std::path::PathBuf;
use std::sync::OnceLock;

use orchard::circuit::{OrchardCircuitVersion, VerifyingKey};
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use sapling::circuit::{OutputParameters, SpendParameters};
use transparent::address::Script;
use transparent::bundle::TxOut;
use transparent::sighash::TransparentAuthorizingContext;
use zcash_primitives::transaction::sighash::{signature_hash, SignableInput};
use zcash_primitives::transaction::txid::TxIdDigester;
use zcash_primitives::transaction::{Authorization, Transaction, TransactionData};
use zcash_protocol::value::Zatoshis;

/// Why a transaction is not authorized, or why that could not be decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// A proof or signature does not verify.
    Invalid(String),
    /// The check needs something this machine does not have (the Sapling parameters).
    Setup(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Invalid(e) => write!(f, "{e}"),
            AuthError::Setup(e) => write!(f, "Setup required: {e}"),
        }
    }
}

/// The amounts and scripts of the outputs a transaction's transparent inputs spend, in input order:
/// what ZIP 244 commits to for a transaction with transparent inputs.
#[derive(Debug, Clone)]
pub struct Prevouts(pub Vec<TxOut>);

impl transparent::bundle::Authorization for Prevouts {
    type ScriptSig = <transparent::bundle::Authorized as transparent::bundle::Authorization>::ScriptSig;
}

impl TransparentAuthorizingContext for Prevouts {
    fn input_amounts(&self) -> Vec<Zatoshis> {
        self.0.iter().map(|o| o.value()).collect()
    }
    fn input_scriptpubkeys(&self) -> Vec<Script> {
        self.0.iter().map(|o| o.script_pubkey().clone()).collect()
    }
}

struct WithPrevouts;
impl Authorization for WithPrevouts {
    type TransparentAuth = Prevouts;
    type SaplingAuth = sapling::bundle::Authorized;
    type OrchardAuth = orchard::bundle::Authorized;
}

struct AttachPrevouts(Prevouts);
impl transparent::bundle::MapAuth<transparent::bundle::Authorized, Prevouts> for AttachPrevouts {
    fn map_script_sig(&self, s: <transparent::bundle::Authorized as transparent::bundle::Authorization>::ScriptSig) -> <Prevouts as transparent::bundle::Authorization>::ScriptSig {
        s
    }
    fn map_authorization(&self, _: transparent::bundle::Authorized) -> Prevouts {
        self.0.clone()
    }
}

/// The signature hash every shielded signature in `tx` signs (ZIP 244 `SIGHASH_ALL`, no transparent input
/// selected). `prevouts` must list what each transparent input spends; empty when there are none.
pub fn shielded_sighash(tx: &Transaction, prevouts: &[TxOut]) -> Result<[u8; 32], AuthError> {
    // A coinbase input spends nothing: ZIP 244 commits to no previous outputs for it.
    let inputs = tx.transparent_bundle().filter(|b| !b.is_coinbase()).map_or(0, |b| b.vin.len());
    if prevouts.len() != inputs {
        return Err(AuthError::Invalid(format!("{inputs} transparent inputs but {} spent outputs", prevouts.len())));
    }
    let mut bytes = Vec::new();
    tx.write(&mut bytes).map_err(|e| AuthError::Invalid(e.to_string()))?;
    let copy = Transaction::read(&bytes[..], tx.consensus_branch_id()).map_err(|e| AuthError::Invalid(e.to_string()))?;
    let data: TransactionData<WithPrevouts> = copy.into_data().map_authorization(AttachPrevouts(Prevouts(prevouts.to_vec())), (), ());
    let parts = data.digest(TxIdDigester);
    Ok(*signature_hash(&data, &SignableInput::Shielded, &parts).as_ref())
}

fn orchard_vk(v: OrchardCircuitVersion) -> &'static VerifyingKey {
    static INSECURE: OnceLock<VerifyingKey> = OnceLock::new();
    static FIXED: OnceLock<VerifyingKey> = OnceLock::new();
    static NU6_3: OnceLock<VerifyingKey> = OnceLock::new();
    let cell = match v {
        OrchardCircuitVersion::InsecurePreNu6_2 => &INSECURE,
        OrchardCircuitVersion::FixedPostNu6_2 => &FIXED,
        OrchardCircuitVersion::PostNu6_3 => &NU6_3,
    };
    cell.get_or_init(|| VerifyingKey::build(v))
}

/// BLAKE2b-512 of the published Sapling parameters (the values zcash_proofs checks).
const SAPLING_SPEND_HASH: &str = "8270785a1a0d0bc77196f000ee6d221c9c9894f55307bd9357c3f0105d31ca63991ab91324160d8f53e2bbd3c2633a6eb8bdf5205d822e7f3f73edac51b2b70c";
const SAPLING_OUTPUT_HASH: &str = "657e3d38dbb5cb5e7dd2970e8b03d69b4787dd907285b5a7f0790dcc8072f60bf593b32cc2d1c030e00ff5ae64bf84c5c3beb84ddc841d48264b4a171744d028";

/// ZPV_SAPLING_PARAMS, else where zcashd and the wallets put them.
fn sapling_params_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("ZPV_SAPLING_PARAMS") {
        return Some(PathBuf::from(d));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    [home.join("Library/Application Support/ZcashParams"), home.join(".zcash-params"), home.join(".local/share/ZcashParams")].into_iter().find(|d| d.join("sapling-spend.params").exists())
}

fn read_params(name: &str, hash: &str) -> Result<Vec<u8>, AuthError> {
    let dir = sapling_params_dir().ok_or_else(|| AuthError::Setup(format!("ZPV_SAPLING_PARAMS (a folder with {name}; this transaction has a Sapling part and its proofs need the Sapling parameters)")))?;
    let path = dir.join(name);
    let bytes = std::fs::read(&path).map_err(|e| AuthError::Setup(format!("ZPV_SAPLING_PARAMS ({}: {e})", path.display())))?;
    let got = blake2b_simd::Params::new().hash_length(64).hash(&bytes).to_hex();
    if got.as_str() != hash {
        return Err(AuthError::Setup(format!("ZPV_SAPLING_PARAMS ({} is not the published {name}: BLAKE2b {}…)", path.display(), &got.as_str()[..16])));
    }
    Ok(bytes)
}

fn sapling_params() -> Result<&'static (SpendParameters, OutputParameters), AuthError> {
    static PARAMS: OnceLock<(SpendParameters, OutputParameters)> = OnceLock::new();
    if let Some(p) = PARAMS.get() {
        return Ok(p);
    }
    let spend = SpendParameters::read(&read_params("sapling-spend.params", SAPLING_SPEND_HASH)?[..], false).map_err(|e| AuthError::Setup(format!("ZPV_SAPLING_PARAMS (sapling-spend.params: {e})")))?;
    let output = OutputParameters::read(&read_params("sapling-output.params", SAPLING_OUTPUT_HASH)?[..], false).map_err(|e| AuthError::Setup(format!("ZPV_SAPLING_PARAMS (sapling-output.params: {e})")))?;
    Ok(PARAMS.get_or_init(|| (spend, output)))
}

/// Checks every proof and signature in `tx` (see the module docs for what that does and does not cover).
/// `prevouts`: the outputs its transparent inputs spend, in order.
pub fn check_authorization(tx: &Transaction, prevouts: &[TxOut]) -> Result<(), AuthError> {
    let sighash = shielded_sighash(tx, prevouts)?;
    for (pool, bundle) in [("Orchard", tx.orchard_bundle()), ("Ironwood", tx.ironwood_bundle())] {
        let Some(b) = bundle else { continue };
        let vk = orchard_vk(b.bundle_version().circuit_version());
        let mut v = orchard::bundle::BatchValidator::new(vk);
        v.add_bundle(b, sighash).map_err(|e| AuthError::Invalid(format!("{pool} bundle: {e}")))?;
        if !v.validate(UnwrapErr(SysRng)) {
            return Err(AuthError::Invalid(format!("the {pool} proof or a signature over the transaction does not verify")));
        }
    }
    if let Some(b) = tx.sapling_bundle() {
        let (spend, output) = sapling_params()?;
        let mut v = sapling::BatchValidator::new();
        if !v.check_bundle(b.clone(), sighash) || !v.validate(&spend.verifying_key(), &output.verifying_key(), UnwrapErr(SysRng)) {
            return Err(AuthError::Invalid("a Sapling proof or a signature over the transaction does not verify".into()));
        }
    }
    Ok(())
}
