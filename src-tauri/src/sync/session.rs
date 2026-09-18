//! One request, one stream, one reply.

use std::time::Duration;

use iroh::endpoint::{Connection, ConnectionError, ReadError, RecvStream, WriteError};

use super::protocol::{self, Request, Response};

#[derive(Clone, Debug)]
pub struct Identity {
    pub device_name: String,
    pub notes_id: String,
    /// This device's endpoint id, which is also its name in version vectors.
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Failure {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn refused(refusal: protocol::Refusal) -> Self {
        Failure::new(refusal.code(), refusal.to_string())
    }

    pub fn from_peer(message: String) -> Self {
        Failure::new("peer_error", message)
    }

    pub fn unexpected(what: &str, response: &Response) -> Self {
        Failure::new(
            "unexpected_reply",
            format!("unexpected reply to {what}: {response:?}"),
        )
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Concurrent, since applying a round can take a while and an accept loop answering in line is deaf
/// meanwhile. At most `IN_FLIGHT` at once; the rest wait unaccepted under QUIC flow control.
/// `limit` is per stream because pairing state can change while connected.
pub async fn serve_streams<H, F>(connection: Connection, limit: impl Fn() -> usize, handle: H)
where
    H: Fn(Vec<u8>) -> F + Clone + Send + 'static,
    F: std::future::Future<Output = Vec<u8>> + Send + 'static,
{
    let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(IN_FLIGHT));
    loop {
        let Ok(slot) = slots.clone().acquire_owned().await else {
            return;
        };
        let Ok((mut send, mut recv)) = connection.accept_bi().await else {
            return;
        };
        let limit = limit();
        let handle = handle.clone();

        // Reading inside the task too, so a slow sender does not block the next stream.
        tauri::async_runtime::spawn(async move {
            let _slot = slot;
            let Ok(bytes) = recv.read_to_end(limit).await else {
                return;
            };
            if send.write_all(&handle(bytes).await).await.is_ok() {
                let _ = send.finish();
            }
        });
    }
}

/// How many of one peer's requests are answered at once. See `serve_streams`.
const IN_FLIGHT: usize = 4;

/// Bounds silence, not the whole reply: a large image over a relay is slow but honest. Generous
/// because a manifest means scanning the folder first.
const SILENCE: Duration = Duration::from_secs(5 * 60);

/// Begin, Apply and Commit have none: work on the peer's disk that sends nothing until done. The
/// connection bounds them.
fn silence_for(request: &Request) -> Option<Duration> {
    match request {
        Request::Begin { .. } | Request::Apply { .. } | Request::Commit { .. } => None,
        _ => Some(SILENCE),
    }
}

pub async fn request(connection: &Connection, request: &Request) -> Result<Response, String> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|e| format!("opening a sync stream: {}", why(&e)))?;
    send.write_all(&protocol::encode(request)?)
        .await
        .map_err(|e| match e {
            WriteError::ConnectionLost(cause) => {
                format!("sending a sync request: {}", why(&cause))
            }
            other => format!("sending a sync request: {other}"),
        })?;
    send.finish()
        .map_err(|e| format!("finishing a sync request: {e}"))?;
    let bytes = read_reply(&mut recv, protocol::MAX_MESSAGE, silence_for(request)).await?;
    protocol::decode(&bytes)
}

/// The clock restarts whenever anything arrives.
async fn read_reply(
    recv: &mut RecvStream,
    limit: usize,
    silence: Option<Duration>,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let next = recv.read_chunk(limit);
        let chunk = match silence {
            Some(silence) => tokio::time::timeout(silence, next).await.map_err(|_| {
                format!(
                    "the other device stopped replying (nothing for {} minutes)",
                    silence.as_secs().div_ceil(60)
                )
            })?,
            None => next.await,
        };
        match chunk {
            Ok(Some(bytes)) => {
                if out.len() + bytes.len() > limit {
                    return Err(format!(
                        "reading a sync reply: it is over the {limit} byte limit"
                    ));
                }
                out.extend_from_slice(&bytes);
            }
            Ok(None) => return Ok(out),
            Err(ReadError::ConnectionLost(cause)) => {
                return Err(format!("reading a sync reply: {}", why(&cause)))
            }
            Err(other) => return Err(format!("reading a sync reply: {other}")),
        }
    }
}

fn why(error: &ConnectionError) -> String {
    match error {
        ConnectionError::ApplicationClosed(close) if !close.reason.is_empty() => format!(
            "the other device closed the connection: {}",
            String::from_utf8_lossy(&close.reason)
        ),
        other => other.to_string(),
    }
}

pub fn transport(message: String) -> Failure {
    Failure::new("transport", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::{Endpoint, EndpointAddr, SecretKey, TransportAddr};

    async fn endpoints() -> (Endpoint, Endpoint) {
        let a = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![protocol::ALPN.to_vec()])
            .bind()
            .await
            .expect("bind a");
        let b = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![protocol::ALPN.to_vec()])
            .bind()
            .await
            .expect("bind b");
        (a, b)
    }

    fn dialable(endpoint: &Endpoint) -> EndpointAddr {
        EndpointAddr::from_parts(
            endpoint.id(),
            endpoint.bound_sockets().into_iter().map(|s| {
                TransportAddr::Ip(std::net::SocketAddr::new(
                    "127.0.0.1".parse().unwrap(),
                    s.port(),
                ))
            }),
        )
    }

    #[tokio::test]
    async fn one_slow_request_does_not_stop_the_next_being_answered() {
        // Answered in line with the accept loop, this would leave the connection deaf.
        use std::sync::Arc;
        use tokio::sync::Semaphore;

        let (client, server) = endpoints().await;
        let address = dialable(&server);

        // The slow request says when it has started, and waits to be let go.
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));

        let listening = {
            let (started, release) = (started.clone(), release.clone());
            tokio::spawn(async move {
                let Some(incoming) = server.accept().await else {
                    return;
                };
                let Ok(connection) = incoming.await else {
                    return;
                };
                serve_streams(
                    connection,
                    || protocol::MAX_MESSAGE,
                    move |bytes: Vec<u8>| {
                        let (started, release) = (started.clone(), release.clone());
                        async move {
                            if bytes == b"slow" {
                                started.add_permits(1);
                                let _ = release.acquire().await;
                                b"slow answered".to_vec()
                            } else {
                                release.add_permits(1);
                                b"fast answered".to_vec()
                            }
                        }
                    },
                )
                .await;
            })
        };

        let connection = client
            .connect(address, protocol::ALPN)
            .await
            .expect("connect");

        let ask = |body: &'static [u8]| {
            let connection = connection.clone();
            async move {
                let (mut send, mut recv) = connection.open_bi().await.expect("open");
                send.write_all(body).await.expect("write");
                send.finish().expect("finish");
                recv.read_to_end(protocol::MAX_MESSAGE).await.expect("read")
            }
        };

        let answered = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let slow = tokio::spawn(ask(b"slow"));

            // Only ask the second once the first is certainly in progress.
            let _ = started.acquire().await;
            let fast = ask(b"fast").await;
            (slow.await.expect("slow task"), fast)
        })
        .await
        .expect("a second request must be answered while the first is still running");

        assert_eq!(answered.0, b"slow answered");
        assert_eq!(answered.1, b"fast answered");
        listening.abort();
    }

    /// A server that answers every stream by running `reply` on its send half.
    fn answering<F, Fut>(server: Endpoint, reply: F) -> tokio::task::JoinHandle<()>
    where
        F: Fn(iroh::endpoint::SendStream) -> Fut + Clone + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                return;
            };
            let Ok(connection) = incoming.await else {
                return;
            };
            while let Ok((send, mut recv)) = connection.accept_bi().await {
                let _ = recv.read_to_end(protocol::MAX_MESSAGE).await;
                tokio::spawn(reply.clone()(send));
            }
        })
    }

    /// Open a stream, ask, and read the reply the way `request` does.
    async fn ask_with_silence(
        connection: &Connection,
        silence: Duration,
    ) -> Result<Vec<u8>, String> {
        let (mut send, mut recv) = connection.open_bi().await.expect("open");
        send.write_all(b"question").await.expect("write");
        send.finish().expect("finish");
        read_reply(&mut recv, protocol::MAX_MESSAGE, Some(silence)).await
    }

    #[tokio::test]
    async fn a_slow_reply_that_keeps_arriving_is_never_given_up_on() {
        // Longer in total than the silence allowed, but never silent that long.
        let (client, server) = endpoints().await;
        let address = dialable(&server);
        let serving = answering(server, |mut send| async move {
            for piece in [b"one ".as_slice(), b"two ", b"three"] {
                tokio::time::sleep(Duration::from_millis(150)).await;
                let _ = send.write_all(piece).await;
            }
            let _ = send.finish();
        });

        let connection = client
            .connect(address, protocol::ALPN)
            .await
            .expect("connect");
        let reply = ask_with_silence(&connection, Duration::from_millis(400)).await;
        serving.abort();

        assert_eq!(reply.as_deref(), Ok(b"one two three".as_slice()));
    }

    #[tokio::test]
    async fn a_reply_that_stops_arriving_is_reported_as_the_peer_going_quiet() {
        let (client, server) = endpoints().await;
        let address = dialable(&server);
        let serving = answering(server, |mut send| async move {
            let _ = send.write_all(b"a start").await;
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = send.finish();
        });

        let connection = client
            .connect(address, protocol::ALPN)
            .await
            .expect("connect");
        let reply = ask_with_silence(&connection, Duration::from_millis(300)).await;
        serving.abort();

        let error =
            reply.expect_err("a peer that went quiet mid-reply can't be waited on for ever");
        assert!(error.contains("stopped replying"), "{error}");
    }

    #[tokio::test]
    async fn a_peer_cannot_have_more_than_a_few_requests_answered_at_once() {
        // Requests past the limit wait rather than all being read at once.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::sync::Semaphore;

        let (client, server) = endpoints().await;
        let address = dialable(&server);

        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Semaphore::new(0));

        let listening = {
            let (running, most, release) = (running.clone(), most.clone(), release.clone());
            tokio::spawn(async move {
                let Some(incoming) = server.accept().await else {
                    return;
                };
                let Ok(connection) = incoming.await else {
                    return;
                };
                serve_streams(
                    connection,
                    || protocol::MAX_MESSAGE,
                    move |_bytes: Vec<u8>| {
                        let (running, most, release) =
                            (running.clone(), most.clone(), release.clone());
                        async move {
                            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                            most.fetch_max(now, Ordering::SeqCst);
                            let _ = release.acquire().await.map(|p| p.forget());
                            running.fetch_sub(1, Ordering::SeqCst);
                            b"answered".to_vec()
                        }
                    },
                )
                .await;
            })
        };

        let connection = client
            .connect(address, protocol::ALPN)
            .await
            .expect("connect");
        let asks: Vec<_> = (0..IN_FLIGHT * 3)
            .map(|_| {
                let connection = connection.clone();
                tokio::spawn(async move {
                    let (mut send, mut recv) = connection.open_bi().await.expect("open");
                    send.write_all(b"q").await.expect("write");
                    send.finish().expect("finish");
                    recv.read_to_end(protocol::MAX_MESSAGE).await.expect("read")
                })
            })
            .collect();

        // Give every request the chance to be taken up, then let them all go.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            running.load(Ordering::SeqCst),
            IN_FLIGHT,
            "the limit should be full, and no fuller"
        );
        release.add_permits(IN_FLIGHT * 3);

        for ask in asks {
            let answer = tokio::time::timeout(Duration::from_secs(10), ask)
                .await
                .expect("every request is answered in the end")
                .expect("task");
            assert_eq!(answer, b"answered");
        }
        assert_eq!(most.load(Ordering::SeqCst), IN_FLIGHT);
        listening.abort();
    }
}
