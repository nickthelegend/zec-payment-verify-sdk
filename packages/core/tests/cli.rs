//! The zpay-verify binary as the SDK runs it: settings come from the environment. These cover how it
//! reaches lightwalletd (plaintext refused for a remote host, ZPV_LWD_PROXY never bypassed). Real
//! testnet.zec.rocks where a server is needed; dead local ports where the point is that nothing answers.

use std::process::{Command, Output};
use std::time::{Duration, Instant};

use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/testnet.json")).unwrap()
}

/// `zpay-verify verify <x402 txid> --amount 100000 --memo <its memo>` with the published x402 merchant
/// key and exactly the given extra environment (nothing inherited but PATH).
fn verify_x402(env: &[(&str, &str)]) -> (Output, Duration) {
    let f = &fixtures()["x402"];
    let mut c = Command::new(env!("CARGO_BIN_EXE_zpay-verify"));
    c.env_clear().env("PATH", std::env::var("PATH").unwrap_or_default()).env("ZPV_UIVK", f["uivk"].as_str().unwrap());
    for (k, v) in env {
        c.env(k, v);
    }
    c.args(["verify", f["txid"].as_str().unwrap(), "--amount", "100000", "--memo", f["memo"].as_str().unwrap()]);
    let t = Instant::now();
    let out = c.output().unwrap();
    (out, t.elapsed())
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn plaintext_http_to_a_remote_host_is_refused_before_any_connection() {
    // 203.0.113.1 is TEST-NET-3: a connection attempt would hang until the 10 s connect timeout.
    let (o, took) = verify_x402(&[("ZPV_LWD_URL", "http://203.0.113.1:9067")]);
    assert_eq!(o.status.code(), Some(2), "{}", stderr(&o));
    assert!(stderr(&o).contains("plaintext http:// is refused"), "{}", stderr(&o));
    assert!(took < Duration::from_secs(3), "refused only after {took:?}: it tried to connect");
}

#[test]
fn plaintext_http_to_loopback_is_allowed() {
    // Nothing listens on 127.0.0.1:1: the attempt is made and fails as a connection error.
    let (o, _) = verify_x402(&[("ZPV_LWD_URL", "http://127.0.0.1:1")]);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("cannot connect to lightwalletd"), "{}", stderr(&o));
}

#[test]
fn zpv_allow_insecure_lwd_lets_a_remote_plaintext_url_through() {
    // Plaintext HTTP/2 to the real server's TLS port: the connection is attempted (and fails), not refused by policy.
    let (o, _) = verify_x402(&[("ZPV_LWD_URL", "http://testnet.zec.rocks:443"), ("ZPV_ALLOW_INSECURE_LWD", "1")]);
    assert_eq!(o.status.code(), Some(2));
    assert!(!stderr(&o).contains("plaintext http:// is refused"), "{}", stderr(&o));
    assert!(stderr(&o).contains("lightwalletd"), "{}", stderr(&o));
}

#[test]
fn a_dead_proxy_fails_loudly_and_is_never_bypassed() {
    // testnet.zec.rocks is up (a direct connection would print a paid verdict), so exit 2 here means
    // the binary went to the proxy and did not fall back to a direct connection.
    let (o, _) = verify_x402(&[("ZPV_LWD_PROXY", "socks5h://127.0.0.1:1")]);
    assert_eq!(o.status.code(), Some(2), "stdout: {}", String::from_utf8_lossy(&o.stdout));
    assert!(o.stdout.is_empty());
    assert!(stderr(&o).contains("via proxy socks5h://127.0.0.1:1"), "{}", stderr(&o));
}

#[test]
fn a_proxy_url_that_is_not_socks5_is_a_setup_error() {
    let (o, _) = verify_x402(&[("ZPV_LWD_PROXY", "http://127.0.0.1:8080")]);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("ZPV_LWD_PROXY must be socks5h://host:port"), "{}", stderr(&o));
}

/// `zpay-verify owns <ua>` with ZPV_UIVK = `uivk`. Offline: decrypting a diversifier needs no server.
fn owns(uivk: &str, ua: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_zpay-verify")).env_clear().env("ZPV_UIVK", uivk).args(["owns", ua]).output().unwrap()
}

#[test]
fn owns_says_whether_an_address_belongs_to_the_viewing_key() {
    let run: Value = serde_json::from_str(include_str!("../../../deployments/testnet.json")).unwrap();
    let w = &run["wallets"];
    let (merchant, employee) = (&w["merchant"], &w["employee"]);
    let (m_ua, m_key) = (merchant["address"].as_str().unwrap(), merchant["uivk"].as_str().unwrap());
    let yes = owns(m_key, m_ua);
    assert_eq!(yes.status.code(), Some(0), "{}", stderr(&yes));
    let j: Value = serde_json::from_slice(&yes.stdout).unwrap();
    assert_eq!(j["owns"], true);
    assert_eq!(j["orchard"], true);
    let e = owns(employee["uivk"].as_str().unwrap(), employee["address"].as_str().unwrap());
    assert_eq!(e.status.code(), Some(0));
    // The merchant's address under the x402 merchant's key, and the employee's under the merchant's: not theirs.
    for (key, ua) in [(fixtures()["x402"]["uivk"].as_str().unwrap(), m_ua), (m_key, employee["address"].as_str().unwrap())] {
        let no = owns(key, ua);
        assert_eq!(no.status.code(), Some(1), "{}", stderr(&no));
        assert_eq!(serde_json::from_slice::<Value>(&no.stdout).unwrap()["owns"], false);
    }
    // Not an address, or a transparent-only one: could not check.
    for bad in ["utest1notanaddress", w["payer"]["transparent"].as_str().unwrap()] {
        let o = owns(m_key, bad);
        assert_eq!(o.status.code(), Some(2), "{bad}");
        assert!(stderr(&o).contains("not a testnet unified address with a shielded receiver"), "{}", stderr(&o));
    }
}
