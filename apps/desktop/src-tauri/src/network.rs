//! Native network change notifications (stage 7.3), for the stream lifecycle's URL cache.
//!
//! YouTube's stream URLs only work from the IP address that resolved them, so the web app drops
//! its cached URLs whenever the network changes. A webview reports only `online` and `offline`
//! (Chromium also the Network Information API, whose estimates change all the time), so this
//! module watches the route instead: every [`POLL_INTERVAL`] it asks the operating system which
//! local address it would use to reach the internet, over IPv4 and IPv6, and tells the main
//! window when either changes ([`NETWORK_EVENT`]). That catches a new Wi-Fi network, a cable,
//! a VPN going up or down, and a new temporary IPv6 address.
//!
//! Asking sends nothing: connecting a UDP socket only picks the route and the source address.
//! The destinations are documentation addresses (RFC 5737, RFC 3849), which nothing answers.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter, Runtime};

use crate::MAIN_WINDOW;

/// The event the main window receives when the network changed. It carries no payload: the
/// addresses stay in Rust.
pub const NETWORK_EVENT: &str = "fxm-network-change";

/// How often the route is checked.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// An IPv4 destination for the route lookup: TEST-NET-3 (RFC 5737), port 9 (discard).
const IPV4_PROBE: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1)), 9);

/// An IPv6 destination for the route lookup: the documentation prefix (RFC 3849), port 9.
const IPV6_PROBE: SocketAddr = SocketAddr::new(
    IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1)),
    9,
);

/// The local addresses the operating system would send internet traffic from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Route {
    /// Over IPv4, or `None` without an IPv4 route.
    pub ipv4: Option<IpAddr>,
    /// Over IPv6, or `None` without an IPv6 route.
    pub ipv6: Option<IpAddr>,
}

impl Route {
    /// The route now.
    pub fn current() -> Self {
        Self {
            ipv4: source_address(IPV4_PROBE),
            ipv6: source_address(IPV6_PROBE),
        }
    }
}

/// The local address the operating system picks to reach `destination`, without sending
/// anything; `None` when there is no route.
fn source_address(destination: SocketAddr) -> Option<IpAddr> {
    let any: SocketAddr = match destination {
        SocketAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
        SocketAddr::V6(_) => (Ipv6Addr::UNSPECIFIED, 0).into(),
    };
    let socket = UdpSocket::bind(any).ok()?;
    socket.connect(destination).ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_unspecified()).then_some(address)
}

/// Remembers the last route and says when a new one differs.
#[derive(Debug)]
pub struct RouteWatch {
    last: Route,
}

impl RouteWatch {
    /// Starts from `route`.
    pub fn new(route: Route) -> Self {
        Self { last: route }
    }

    /// Records `route`; whether it differs from the last one.
    pub fn changed(&mut self, route: Route) -> bool {
        let changed = route != self.last;
        self.last = route;
        changed
    }
}

/// Watches the route on a background thread for as long as FXM runs, and emits
/// [`NETWORK_EVENT`] to the main window on every change.
pub fn watch<R: Runtime>(app: AppHandle<R>) {
    let spawned = thread::Builder::new()
        .name("fxm-network-watch".into())
        .spawn(move || {
            let mut watch = RouteWatch::new(Route::current());
            loop {
                thread::sleep(POLL_INTERVAL);
                if watch.changed(Route::current()) {
                    // Best effort: the page may still be loading.
                    let _ = app.emit_to(MAIN_WINDOW, NETWORK_EVENT, ());
                }
            }
        });
    if let Err(error) = spawned {
        // The web app still flushes on `online`, `offline` and a 403 for a cached URL.
        eprintln!("FXM could not watch the network: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: Route = Route {
        ipv4: Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))),
        ipv6: None,
    };

    #[test]
    fn the_probes_are_documentation_addresses() {
        assert_eq!(IPV4_PROBE.ip(), IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1)));
        let IpAddr::V6(ipv6) = IPV6_PROBE.ip() else {
            panic!("the IPv6 probe is an IPv6 address");
        };
        assert_eq!(ipv6.segments()[..2], [0x2001, 0x0db8]);
    }

    #[test]
    fn reads_the_current_route_without_failing_offline() {
        let route = Route::current();
        for address in [route.ipv4, route.ipv6].into_iter().flatten() {
            assert!(
                !address.is_unspecified() && !address.is_loopback(),
                "{address}"
            );
        }
        assert!(route.ipv4.is_none_or(|address| address.is_ipv4()));
        assert!(route.ipv6.is_none_or(|address| address.is_ipv6()));
    }

    #[test]
    fn reports_a_change_once() {
        let mut watch = RouteWatch::new(HOME);
        assert!(!watch.changed(HOME));
        let vpn = Route {
            ipv4: Some(IpAddr::V4(Ipv4Addr::new(10, 8, 0, 2))),
            ..HOME
        };
        assert!(watch.changed(vpn));
        assert!(!watch.changed(vpn));
        let offline = Route {
            ipv4: None,
            ipv6: None,
        };
        assert!(watch.changed(offline));
        assert!(watch.changed(HOME));
    }
}
