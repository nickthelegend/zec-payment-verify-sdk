//! How the library reaches lightwalletd: through a SOCKS5 proxy (ZPV_LWD_PROXY), and never in
//! plaintext to a remote host by default. The proxy here is a real SOCKS5 server on 127.0.0.1 that
//! forwards to the real testnet.zec.rocks and records each CONNECT target it was asked for.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use zpay_verify::{lwd, verify, verify_with, Expect};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/testnet.json")).unwrap()
}

fn x402() -> (String, String, Expect) {
    let f = &fixtures()["x402"];
    (
        f["uivk"].as_str().unwrap().to_string(),
        f["txid"].as_str().unwrap().to_string(),
        Expect { amount_zat: 100_000, memo: f["memo"].as_str().map(String::from), min_conf: 1, shielded_only: true },
    )
}

/// A minimal RFC 1928 SOCKS5 server (no auth, CONNECT only) that forwards to the requested host.
async fn socks5_server() -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut g = [0u8; 2];
                c.read_exact(&mut g).await?;
                let mut methods = vec![0u8; g[1] as usize];
                c.read_exact(&mut methods).await?;
                c.write_all(&[5, 0]).await?;
                let mut h = [0u8; 4];
                c.read_exact(&mut h).await?;
                let host = match h[3] {
                    3 => {
                        let mut n = [0u8; 1];
                        c.read_exact(&mut n).await?;
                        let mut b = vec![0u8; n[0] as usize];
                        c.read_exact(&mut b).await?;
                        format!("name:{}", String::from_utf8_lossy(&b))
                    }
                    1 => {
                        let mut b = [0u8; 4];
                        c.read_exact(&mut b).await?;
                        format!("ip:{}", std::net::Ipv4Addr::from(b))
                    }
                    _ => return Ok::<_, std::io::Error>(()),
                };
                let mut p = [0u8; 2];
                c.read_exact(&mut p).await?;
                let port = u16::from_be_bytes(p);
                log.lock().unwrap().push(format!("{host}:{port}"));
                let target = host.split_once(':').unwrap().1.to_string();
                let mut up = TcpStream::connect((target.as_str(), port)).await?;
                c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                tokio::io::copy_bidirectional(&mut c, &mut up).await?;
                Ok(())
            });
        }
    });
    (addr, seen)
}

#[tokio::test]
async fn a_real_socks5_proxy_carries_the_check_and_resolves_the_name() {
    let (uivk, txid, e) = x402();
    let (proxy, seen) = socks5_server().await;
    let o = lwd::ConnectOptions { proxy: Some(format!("socks5h://{proxy}")), allow_insecure: false };
    let v = verify_with(lwd::DEFAULT_LWD_URL, &o, &uivk, &txid, &e).await.unwrap();
    assert!(v.verdict.ok, "{:?}", v.verdict);
    assert_eq!(v.report.height, Some(4_521_112));
    // socks5h: the proxy was given the host name (not an address this machine resolved), and TLS ran inside the tunnel.
    assert_eq!(seen.lock().unwrap().as_slice(), ["name:testnet.zec.rocks:443"]);
}

#[tokio::test]
async fn socks5_without_h_resolves_here_and_sends_an_address() {
    let (uivk, txid, e) = x402();
    let (proxy, seen) = socks5_server().await;
    let o = lwd::ConnectOptions { proxy: Some(format!("socks5://{proxy}")), allow_insecure: false };
    assert!(verify_with(lwd::DEFAULT_LWD_URL, &o, &uivk, &txid, &e).await.unwrap().verdict.ok);
    let s = seen.lock().unwrap();
    assert_eq!(s.len(), 1);
    assert!(s[0].starts_with("ip:") && s[0].ends_with(":443"), "{s:?}");
}

#[tokio::test]
async fn a_dead_proxy_is_an_error_and_never_a_direct_connection() {
    let (uivk, txid, e) = x402();
    let o = lwd::ConnectOptions { proxy: Some("socks5h://127.0.0.1:1".into()), allow_insecure: false };
    let err = verify_with(lwd::DEFAULT_LWD_URL, &o, &uivk, &txid, &e).await.unwrap_err();
    assert!(err.to_string().starts_with("cannot connect to lightwalletd: https://testnet.zec.rocks:443 via proxy socks5h://127.0.0.1:1"), "{err}");
}

#[tokio::test]
async fn plaintext_to_a_remote_host_is_refused_without_a_connection_attempt() {
    let (uivk, txid, e) = x402();
    let t = Instant::now();
    let err = verify("http://203.0.113.1:9067", &uivk, &txid, &e).await.unwrap_err();
    assert!(err.to_string().contains("plaintext http:// is refused"), "{err}");
    assert!(t.elapsed() < Duration::from_secs(2));
    // IPv6 loopback and localhost count as loopback: the attempt is made (and nothing listens).
    for u in ["http://[::1]:1", "http://localhost:1"] {
        let err = verify(u, &uivk, &txid, &e).await.unwrap_err();
        assert!(err.to_string().contains("cannot connect to lightwalletd"), "{u}: {err}");
    }
    // Any other scheme is not a lightwalletd URL.
    assert!(verify("ftp://testnet.zec.rocks:443", &uivk, &txid, &e).await.unwrap_err().to_string().contains("scheme must be https://"));
}
