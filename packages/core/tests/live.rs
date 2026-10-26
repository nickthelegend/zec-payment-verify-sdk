//! Against Zcash testnet through a real lightwalletd (ZPV_LWD_URL, default testnet.zec.rocks):
//! real mined transactions, decrypted with incoming viewing keys their owners published.

use serde_json::Value;
use zpay_verify::{lwd, verify, Expect};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/testnet.json")).unwrap()
}

fn url() -> String {
    std::env::var("ZPV_LWD_URL").unwrap_or_else(|_| lwd::DEFAULT_LWD_URL.to_string())
}

fn expect(amount: u64, memo: Option<&str>) -> Expect {
    Expect { amount_zat: amount, memo: memo.map(String::from), min_conf: 1, shielded_only: true }
}

#[tokio::test]
async fn x402_payment_verifies_with_the_merchant_key() {
    let f = &fixtures()["x402"];
    let v = verify(&url(), f["uivk"].as_str().unwrap(), f["txid"].as_str().unwrap(), &expect(100_000, f["memo"].as_str())).await.unwrap();
    assert!(v.verdict.ok, "{:?}", v.verdict);
    assert_eq!(v.verdict.paid_zat, 100_000);
    assert_eq!(v.report.height, Some(4_521_112));
    assert!(v.report.confirmations > 1_000);
    assert_eq!(v.report.outputs[0].pool, "Ironwood");
    assert!(!v.report.pools.transparent);
}

#[tokio::test]
async fn wrong_memo_or_higher_amount_is_refused() {
    let f = &fixtures()["x402"];
    let (k, t) = (f["uivk"].as_str().unwrap(), f["txid"].as_str().unwrap());
    let memo = verify(&url(), k, t, &expect(100_000, Some("x402z-some-other-invoice"))).await.unwrap();
    assert_eq!(memo.verdict.reasons, vec!["MEMO_MISMATCH", "AMOUNT_TOO_LOW"]);
    let amount = verify(&url(), k, t, &expect(100_001, f["memo"].as_str())).await.unwrap();
    assert_eq!(amount.verdict.reasons, vec!["AMOUNT_TOO_LOW"]);
    assert_eq!(amount.verdict.paid_zat, 100_000);
}

#[tokio::test]
async fn a_payment_to_someone_else_shows_nothing_to_this_key() {
    let (x, a) = (&fixtures()["x402"], &fixtures()["auction"]);
    // The auction deposit is real and mined, but it does not pay the x402 merchant.
    let v = verify(&url(), x["uivk"].as_str().unwrap(), a["deposit"]["txid"].as_str().unwrap(), &expect(1, None)).await.unwrap();
    assert!(v.report.found);
    assert!(v.report.outputs.is_empty());
    assert_eq!(v.verdict.reasons, vec!["NO_OUTPUT_TO_KEY"]);
    // The auction's own key sees it, memo and amount.
    let own = verify(&url(), a["uivk"].as_str().unwrap(), a["deposit"]["txid"].as_str().unwrap(), &expect(2_000_000, a["deposit"]["memo"].as_str())).await.unwrap();
    assert!(own.verdict.ok, "{:?}", own.verdict);
}

#[tokio::test]
async fn unknown_txid_and_bad_inputs() {
    let f = &fixtures()["x402"];
    let gone = verify(&url(), f["uivk"].as_str().unwrap(), &"ab".repeat(32), &expect(1, None)).await.unwrap();
    assert_eq!(gone.verdict.reasons, vec!["TX_NOT_FOUND"]);
    assert!(verify(&url(), "uivktest1notakey", f["txid"].as_str().unwrap(), &expect(1, None)).await.is_err());
    assert!(verify(&url(), f["uivk"].as_str().unwrap(), "xyz", &expect(1, None)).await.is_err());
}

#[tokio::test]
async fn unreachable_lightwalletd_is_an_error_not_a_verdict() {
    let f = &fixtures()["x402"];
    let e = verify("https://127.0.0.1:9", f["uivk"].as_str().unwrap(), f["txid"].as_str().unwrap(), &expect(1, None)).await.unwrap_err();
    assert!(e.to_string().contains("cannot connect to lightwalletd"), "{e}");
}

#[tokio::test]
async fn the_block_lightwalletd_names_lists_the_tx_and_gives_its_time() {
    // The paywall payment of the live run (deployments/testnet.json) and the x402 payment.
    let run: Value = serde_json::from_str(include_str!("../../../deployments/testnet.json")).unwrap();
    let merchant = run["wallets"]["merchant"]["uivk"].as_str().unwrap();
    let paid = &run["paywall"]["cases"]["paywall"];
    let v = verify(&url(), merchant, paid["txid"].as_str().unwrap(), &expect(10_000, paid["challengeMemo"].as_str())).await.unwrap();
    assert!(v.verdict.ok, "{:?}", v.verdict);
    assert_eq!(v.report.height, Some(4_522_621));
    let t_paywall = v.report.block_time.expect("a mined tx has its block's time");
    // 2026-10-20T16:15:44Z, 87 s before the run that paid it ended (ranAt 2026-10-20T16:17:11Z).
    assert_eq!(t_paywall, 1_792_512_944);
    let f = &fixtures()["x402"];
    let x = verify(&url(), f["uivk"].as_str().unwrap(), f["txid"].as_str().unwrap(), &expect(100_000, f["memo"].as_str())).await.unwrap();
    // An earlier block (4,521,112) has an earlier time.
    assert!(x.report.block_time.unwrap() < t_paywall);
    // Not found: no block, no time.
    let gone = verify(&url(), f["uivk"].as_str().unwrap(), &"ab".repeat(32), &expect(1, None)).await.unwrap();
    assert_eq!(gone.report.block_time, None);
}

#[tokio::test]
async fn an_answer_whose_block_does_not_list_the_tx_is_inconsistent() {
    // The real compact block at the x402 payment's height, then the same block with the tx taken out
    // or another height: what a server that forged the transaction (or the height) would have to serve.
    let f = &fixtures()["x402"];
    let id = lwd::parse_txid(f["txid"].as_str().unwrap()).unwrap();
    let h = zcash_protocol::consensus::BlockHeight::from_u32(4_521_112);
    let mut c = lwd::connect(&url()).await.unwrap();
    let block = lwd::get_block(&mut c, h).await.unwrap();
    let t = zpay_verify::check_inclusion(&block, h, &id).unwrap();
    assert_eq!(t, block.time);
    let mut without = block.clone();
    without.vtx.retain(|tx| tx.txid != id.as_ref().to_vec());
    assert_eq!(without.vtx.len() + 1, block.vtx.len());
    for (candidate, height, detail) in [(&without, h, "does not list"), (&block, h + 1, "height")] {
        let err = zpay_verify::check_inclusion(candidate, height, &id).map_err(zpay_verify::VerifyError::Inconsistent).unwrap_err();
        assert!(err.to_string().starts_with("lightwalletd answered inconsistently"));
        assert!(err.to_string().contains(detail));
    }
}
