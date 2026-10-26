//! Proofs and signatures (src/auth.rs), live: real mined transactions fetched from testnet lightwalletd
//! pass; the same transactions with one output's value altered and re-encrypted to the same recipient
//! (what a server forging a payment would hand over), or with their proof bytes or binding signature
//! changed (which leaves the txid as it is: ZIP 244 txids do not cover authorization data), are refused.

use nonempty::NonEmpty;
use orchard::bundle::{Authorized, Bundle};
use orchard::keys::PreparedIncomingViewingKey;
use orchard::note::{ExtractedNoteCommitment, TransmittedNoteCiphertext};
use orchard::note_encryption::{IronwoodDomain, IronwoodNoteEncryption};
use orchard::value::NoteValue;
use orchard::{Action, Note, Proof};
use serde_json::Value;
use zcash_note_encryption::{try_note_decryption, Domain};
use zcash_primitives::transaction::{Transaction, TransactionData, TxVersion};
use zcash_protocol::consensus::{BlockHeight, BranchId};
use zpay_verify::{auth, authorized, check, decrypt_outputs, lwd, parse_uivk, Expect, TxReport, VerifyError, NETWORK};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/testnet.json")).unwrap()
}

fn url() -> String {
    std::env::var("ZPV_LWD_URL").unwrap_or_else(|_| lwd::DEFAULT_LWD_URL.to_string())
}

/// The real transaction bytes and the height they were mined at, from lightwalletd.
async fn fetch(txid: &str) -> (Transaction, BlockHeight) {
    let mut c = lwd::connect(&url()).await.unwrap();
    let id = lwd::parse_txid(txid).unwrap();
    let (data, h) = match lwd::get_transaction(&mut c, &id).await.unwrap() {
        lwd::FetchedTx::Found { data, location: lwd::TxLocation::Mined(h) } => (data, h),
        _ => panic!("{txid} is not a mined transaction lightwalletd has"),
    };
    let tx = Transaction::read(&data[..], BranchId::for_height(&NETWORK, h)).unwrap();
    assert_eq!(tx.txid(), id);
    (tx, h)
}

/// `tx` with its Ironwood bundle replaced.
fn with_ironwood(tx: &Transaction, b: Bundle<Authorized, zcash_protocol::value::ZatBalance>) -> Transaction {
    assert_eq!(tx.version(), TxVersion::V6, "the published payments are v6 (NU7) transactions");
    TransactionData::from_parts_v6(tx.consensus_branch_id(), tx.lock_time(), tx.expiry_height(), tx.transparent_bundle().cloned(), tx.sapling_bundle().cloned(), tx.orchard_bundle().cloned(), Some(b)).freeze().unwrap()
}

fn rebuild(b: &Bundle<Authorized, zcash_protocol::value::ZatBalance>, actions: Vec<Action<orchard::primitives::redpallas::Signature<orchard::primitives::redpallas::SpendAuth>>>, auth: Authorized) -> Bundle<Authorized, zcash_protocol::value::ZatBalance> {
    Bundle::try_from_parts(NonEmpty::from_vec(actions).unwrap(), *b.flags(), *b.value_balance(), *b.anchor(), auth, b.bundle_version()).unwrap()
}

fn report(tx: &Transaction, outputs: Vec<zpay_verify::Output>, h: BlockHeight) -> TxReport {
    TxReport { txid: tx.txid().to_string(), found: true, height: Some(h.into()), block_time: None, confirmations: 10, tip: u32::from(h) + 9, outputs, pools: Default::default() }
}

#[tokio::test]
async fn real_payments_pass_and_a_payment_with_one_value_altered_and_reencrypted_is_refused() {
    let f = &fixtures()["x402"];
    let key = parse_uivk(f["uivk"].as_str().unwrap()).unwrap();
    let (tx, h) = fetch(f["txid"].as_str().unwrap()).await;
    auth::check_authorization(&tx, &[]).expect("a real mined payment is authorized");
    let paid = decrypt_outputs(&tx, &key, h);
    assert_eq!(paid.iter().map(|o| o.value).collect::<Vec<_>>(), vec![100_000]);

    // Decrypt the merchant's note, make the same note worth ten times as much, encrypt it to the same
    // address again and put it back in the action: everything a forger without the prover needs.
    let ivk = key.orchard().as_ref().unwrap();
    let pivk = PreparedIncomingViewingKey::new(ivk);
    let b = tx.ironwood_bundle().unwrap();
    let mut forged_value = None;
    let actions: Vec<_> = b
        .actions()
        .iter()
        .map(|a| {
            let Some((note, _, memo)) = try_note_decryption(&IronwoodDomain::for_action(a), &pivk, a) else { return a.clone() };
            let more = Note::from_parts(note.recipient(), NoteValue::from_raw(note.value().inner() * 10), note.rho(), *note.rseed(), note.version()).unwrap();
            forged_value = Some(more.value().inner());
            let enc = IronwoodNoteEncryption::new(None, more, memo);
            let cipher = TransmittedNoteCiphertext { epk_bytes: IronwoodDomain::epk_bytes(enc.epk()).0, enc_ciphertext: enc.encrypt_note_plaintext(), out_ciphertext: a.encrypted_note().out_ciphertext };
            Action::from_parts(*a.nullifier(), a.rk().clone(), ExtractedNoteCommitment::from(more.commitment()), cipher, a.cv_net().clone(), a.authorization().clone()).unwrap()
        })
        .collect();
    assert_eq!(forged_value, Some(1_000_000));
    let forged = with_ironwood(&tx, rebuild(b, actions, b.authorization().clone()));
    assert_ne!(forged.txid(), tx.txid(), "the altered output changes the txid; a forging server serves it under that txid");

    // The rules alone would call it paid: the key sees 0.01 TAZ with the invoice memo.
    let seen = decrypt_outputs(&forged, &key, h);
    assert_eq!(seen.iter().map(|o| o.value).collect::<Vec<_>>(), vec![1_000_000]);
    let e = Expect { amount_zat: 1_000_000, memo: f["memo"].as_str().map(String::from), min_conf: 1, shielded_only: true };
    assert!(check(&report(&forged, seen, h), &e).ok);
    // Its proof no longer proves this note commitment: refused, as an inconsistent answer.
    assert!(matches!(auth::check_authorization(&forged, &[]), Err(auth::AuthError::Invalid(_))));
    let err = authorized(&forged, &[]).unwrap_err();
    assert!(matches!(err, VerifyError::Inconsistent(_)));
    assert!(err.to_string().starts_with("lightwalletd answered inconsistently: the transaction's proofs or signatures do not verify"), "{err}");
}

#[tokio::test]
async fn a_changed_proof_or_binding_signature_keeps_the_txid_and_is_refused() {
    let run: Value = serde_json::from_str(include_str!("../../../deployments/testnet.json")).unwrap();
    // The paywall payment of the current code (examples paywall-live, Oct 22).
    let (tx, _) = fetch(run["paywallLive"]["txid"].as_str().unwrap()).await;
    auth::check_authorization(&tx, &[]).expect("a real mined payment is authorized");
    let b = tx.ironwood_bundle().unwrap();
    let actions: Vec<_> = b.actions().iter().cloned().collect();

    let mut proof = b.authorization().proof().as_ref().to_vec();
    proof[100] ^= 1;
    let bad_proof = with_ironwood(&tx, rebuild(b, actions.clone(), Authorized::from_parts(Proof::new(proof), b.authorization().binding_signature().clone())));
    assert_eq!(bad_proof.txid(), tx.txid());
    assert!(matches!(auth::check_authorization(&bad_proof, &[]), Err(auth::AuthError::Invalid(_))));
    assert!(authorized(&bad_proof, &[]).unwrap_err().to_string().starts_with("lightwalletd answered inconsistently"));

    // Another real transaction's binding signature.
    let (other, _) = fetch(fixtures()["x402"]["txid"].as_str().unwrap()).await;
    let sig = other.ironwood_bundle().unwrap().authorization().binding_signature().clone();
    let bad_sig = with_ironwood(&tx, rebuild(b, actions, Authorized::from_parts(b.authorization().proof().clone(), sig)));
    assert_eq!(bad_sig.txid(), tx.txid());
    assert!(matches!(auth::check_authorization(&bad_sig, &[]), Err(auth::AuthError::Invalid(_))));
    assert!(authorized(&bad_sig, &[]).unwrap_err().to_string().starts_with("lightwalletd answered inconsistently"));
}

/// Two third-party testnet transactions that spend transparent coins into a shielded pool (found by
/// scanning recent blocks on Oct 22): one into Sapling, one into Ironwood.
const SHIELDING: [(&str, &str); 2] = [("4a9412fa75194d31fdae2c796765e1617cdeade286ab231ab75705db827c8634", "Sapling"), ("6a508fd30b6d01c0c428cb15f4b652a8e1879936540951bd4e1b35c2b51e5126", "Ironwood")];

#[tokio::test]
async fn transparent_inputs_are_signed_over_with_their_previous_outputs_and_sapling_proofs_are_checked() {
    // The shielded signature hash commits to what the transparent inputs spend, fetched from the same
    // lightwalletd. With the real previous outputs the transaction verifies; with an amount changed by one
    // zatoshi, or with none given, it does not.
    let mut c = lwd::connect(&url()).await.unwrap();
    for (txid, pool) in SHIELDING {
        let (tx, h) = fetch(txid).await;
        assert!(tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty()), "{txid} spends transparent coins");
        assert!(if pool == "Sapling" { tx.sapling_bundle().is_some() } else { tx.ironwood_bundle().is_some() }, "{txid} has a {pool} part");
        let prev = zpay_verify::prevouts(&mut c, &tx, h + 100).await.unwrap();
        assert_eq!(prev.len(), tx.transparent_bundle().unwrap().vin.len());
        auth::check_authorization(&tx, &prev).unwrap_or_else(|e| panic!("{txid}: {e}"));
        let mut wrong = prev.clone();
        wrong[0] = transparent::bundle::TxOut::new((wrong[0].value() + zcash_protocol::value::Zatoshis::const_from_u64(1)).unwrap(), wrong[0].script_pubkey().clone());
        assert!(matches!(auth::check_authorization(&tx, &wrong), Err(auth::AuthError::Invalid(_))), "{txid} with a changed input amount");
        assert!(matches!(auth::check_authorization(&tx, &[]), Err(auth::AuthError::Invalid(_))), "{txid} without its previous outputs");
    }
}

#[tokio::test]
async fn a_sapling_transaction_without_the_sapling_parameters_is_setup_required() {
    // A separate process, so the parameters this process already loaded do not count.
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_zpay-verify"))
        .args(["inspect", SHIELDING[0].0])
        .env("ZPV_UIVK", fixtures()["x402"]["uivk"].as_str().unwrap())
        .env("ZPV_SAPLING_PARAMS", "/nonexistent/zcash-params")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.starts_with("error: Setup required: ZPV_SAPLING_PARAMS ("), "{err}");
}
