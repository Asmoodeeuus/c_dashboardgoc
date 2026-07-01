import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Sla from "./SLA";
import Logs from "./Logs";
import "../Dashboard.css";

const BASE_API_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

export default function Dashboard() {
    const location = useLocation();
    const navigate = useNavigate();

    // --- SYSTEM TIME ---
    const [lastUpdated, setLastUpdated] = useState(new Date().toLocaleTimeString());

    // --- DASHBOARD LAYER STATE ---
    const [currentTableType, setCurrentTableType] = useState('all');
    const [filters, setFilters] = useState({ host: '', service: '', poller: 'all' });
    const [showAllStatusesForPoller, setShowAllStatusesForPoller] = useState(true);

    // --- PAGINATION STATE ---
    const [servicePage, setServicePage] = useState(1);
    const [serviceLimit, setServiceLimit] = useState(100);
    const [serviceMeta, setServiceMeta] = useState({
        page: 1,
        limit: 100,
        total: 0
    });
    const [isLoadingServices, setIsLoadingServices] = useState(false);

    // --- LIVE CACHED API DATA ---
    const [counts, setCounts] = useState({
        allActiveIssues: 0,
        critical: 0,
        warning: 0,
        unknown: 0
    });

    const [cachedCritical, setCachedCritical] = useState([]);
    const [cachedWarning, setCachedWarning] = useState([]);
    const [cachedUnknown, setCachedUnknown] = useState([]);
    const [cachedSearchResults, setCachedSearchResults] = useState([]);
    const [pollerDropdownList, setPollerDropdownList] = useState([]);

    // --- POLLERS DRILL-DOWN STATE ---
    const [cachedPollers, setCachedPollers] = useState([]);
    const [pollerSearch, setPollerSearch] = useState('');
    const [selectedPoller, setSelectedPoller] = useState(null);

    // --- GLOBAL SEARCH STATE ---
    const [debouncedHostSearch, setDebouncedHostSearch] = useState('');
    const [debouncedServiceSearch, setDebouncedServiceSearch] = useState('');

    // ============================================================
    // NORMALIZER HELPERS
    // ============================================================
    const normalizeHost = (host) => {
        return {
            ...host,
            poller_name:
                host.poller_name ||
                (host.poller_id ? `Poller ${host.poller_id}` : 'Default Poller')
        };
    };

    const normalizeService = (service) => {
        const statusCode = Number(service.statusCode ?? service.status?.code ?? service.state);

        const statusName = String(
            service.statusName ||
            service.status?.name ||
            (
                statusCode === 0 ? 'OK' :
                statusCode === 1 ? 'WARNING' :
                statusCode === 2 ? 'CRITICAL' :
                statusCode === 3 ? 'UNKNOWN' :
                'UNKNOWN'
            )
        ).toUpperCase();

        return {
            ...service,
            statusCode,
            statusName,
            poller_name:
                service.poller_name ||
                service.host?.poller_name ||
                (service.host?.poller_id ? `Poller ${service.host.poller_id}` : 'Default Poller')
        };
    };

    // ============================================================
    // ROUTER & SUB-MENU STATE RESET CLEANERS
    // ============================================================
    useEffect(() => {
        if (location.pathname === '/dashboard' && location.state) {
            const { poller, type } = location.state;

            setFilters(f => ({ ...f, poller: poller || 'all' }));

            if (type === 'all') {
                setShowAllStatusesForPoller(true);
                setCurrentTableType('all');
            } else {
                setShowAllStatusesForPoller(false);
                setCurrentTableType(type || 'critical');
            }

            navigate('/dashboard', { replace: true, state: null });
        }

        if (location.pathname !== '/pollers') {
            setSelectedPoller(null);
        }
    }, [location, navigate]);

    // ============================================================
    // HOST SEARCH DEBOUNCE
    // ============================================================
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedHostSearch(filters.host.trim());
            setServicePage(1);
        }, 500);

        return () => clearTimeout(timer);
    }, [filters.host]);

    // ============================================================
    // SERVICE SEARCH DEBOUNCE
    // ============================================================
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedServiceSearch(filters.service.trim());
            setServicePage(1);
        }, 500);

        return () => clearTimeout(timer);
    }, [filters.service]);

    // ============================================================
    // CONNECTED FETCH ENGINE
    // ============================================================
    const refreshDashboardData = useCallback(async () => {
        try {
            setIsLoadingServices(true);

            const token = localStorage.getItem('centreon_auth_token');

            const fetchOptions = {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            };

            const hasGlobalSearch = Boolean(debouncedHostSearch || debouncedServiceSearch);

            const servicesEndpoint = hasGlobalSearch
                ? `${BASE_API_URL}/api/centreon/services/search?host=${encodeURIComponent(debouncedHostSearch)}&service=${encodeURIComponent(debouncedServiceSearch)}&page=${servicePage}&limit=${serviceLimit}`
                : `${BASE_API_URL}/api/centreon/services/status/summary?page=${servicePage}&limit=${serviceLimit}`;

            const [hostsRes, summaryRes] = await Promise.all([
                fetch(`${BASE_API_URL}/api/centreon/hosts/status/all`, fetchOptions),
                fetch(servicesEndpoint, fetchOptions)
            ]);

            if (!hostsRes.ok || !summaryRes.ok) {
                throw new Error("API Connection payload error");
            }

            const hostsPayload = await hostsRes.json();
            const summaryPayload = await summaryRes.json();

            const rawHosts = hostsPayload.data?.result || [];
            const allReturnedServices = (summaryPayload.data?.result || []).map(normalizeService);

            const criticals = (summaryPayload.services?.critical || []).map(normalizeService);
            const warnings = (summaryPayload.services?.warning || []).map(normalizeService);
            const unknowns = (summaryPayload.services?.unknown || []).map(normalizeService);

            setCachedCritical(criticals);
            setCachedWarning(warnings);
            setCachedUnknown(unknowns);

            if (hasGlobalSearch) {
                setCachedSearchResults(allReturnedServices);
            } else {
                setCachedSearchResults([]);
            }

            const criticalCount = summaryPayload.counts?.critical ?? criticals.length;
            const warningCount = summaryPayload.counts?.warning ?? warnings.length;
            const unknownCount = summaryPayload.counts?.unknown ?? unknowns.length;

            const allActiveIssues =
                summaryPayload.counts?.allActiveIssues ??
                summaryPayload.counts?.allServices ??
                criticalCount + warningCount + unknownCount;

            setCounts({
                allActiveIssues,
                critical: criticalCount,
                warning: warningCount,
                unknown: unknownCount
            });

            setServiceMeta(
                summaryPayload.meta || {
                    page: servicePage,
                    limit: serviceLimit,
                    total: summaryPayload.count || allReturnedServices.length || 0
                }
            );

            const normalizedHosts = rawHosts.map(normalizeHost);

            const uniquePollers = [
                ...new Set(
                    normalizedHosts
                        .map(h => h.poller_name)
                        .filter(Boolean)
                )
            ];

            setPollerDropdownList(uniquePollers);
            setLastUpdated(new Date().toLocaleTimeString());

        } catch (e) {
            console.error("Failed syncing infrastructure metrics:", e);
        } finally {
            setIsLoadingServices(false);
        }
    }, [debouncedHostSearch, debouncedServiceSearch, servicePage, serviceLimit]);

    const fetchPollersRoster = useCallback(async () => {
        try {
            const token = localStorage.getItem('centreon_auth_token');

            const response = await fetch(`${BASE_API_URL}/api/centreon/hosts`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }

            const payload = await response.json();
            const rawHosts = payload.data?.result || [];
            const normalizedHosts = rawHosts.map(normalizeHost);

            const pollerMap = {};

            normalizedHosts.forEach(host => {
                const pName = host.poller_name || 'Default Poller';

                if (!pollerMap[pName]) {
                    pollerMap[pName] = {
                        Poller: pName,
                        Critical: 0,
                        Warning: 0,
                        Unknown: 0,
                        Total: 0
                    };
                }

                if (host.state === 1) {
                    pollerMap[pName].Critical++;
                } else if (host.state === 2) {
                    pollerMap[pName].Unknown++;
                } else if (host.state === 3) {
                    pollerMap[pName].Warning++;
                }

                pollerMap[pName].Total++;
            });

            setCachedPollers(Object.values(pollerMap));

        } catch (error) {
            console.error('Error fetching engine pollers roster:', error);
        }
    }, []);

    // ============================================================
    // MANUAL REFRESH
    // ============================================================
    const handleGlobalManualRefresh = () => {
        refreshDashboardData();
        fetchPollersRoster();
    };

    // ============================================================
    // CORE LIFECYCLE SECURITY GUARD
    // ============================================================
    useEffect(() => {
        if (!localStorage.getItem('centreon_auth_token')) {
            if (location.pathname !== '/logout' && location.pathname !== '/login') {
                navigate('/login');
            }
            return;
        }

        refreshDashboardData();
        fetchPollersRoster();

        const heartbeat = setInterval(() => {
            refreshDashboardData();
            fetchPollersRoster();
        }, 300000);

        return () => clearInterval(heartbeat);
    }, [refreshDashboardData, fetchPollersRoster, location.pathname, navigate]);

    // ============================================================
    // MEMOIZED CONTEXT CALCULATIONS
    // ============================================================
    const activePollerContext = useMemo(() => {
        if (location.pathname === '/dashboard') return filters.poller;
        if (location.pathname === '/pollers') return selectedPoller || 'all';
        return 'all';
    }, [location.pathname, filters.poller, selectedPoller]);

    const displayCounts = useMemo(() => {
        if (activePollerContext !== 'all') {
            const critical = cachedCritical.filter(s => s.poller_name === activePollerContext).length;
            const warning = cachedWarning.filter(s => s.poller_name === activePollerContext).length;
            const unknown = cachedUnknown.filter(s => s.poller_name === activePollerContext).length;

            return {
                allActiveIssues: critical + warning + unknown,
                critical,
                warning,
                unknown
            };
        }

        return counts;
    }, [activePollerContext, counts, cachedCritical, cachedWarning, cachedUnknown]);

    const isSearchMode = Boolean(debouncedHostSearch || debouncedServiceSearch);

    const filteredServices = useMemo(() => {
        let source = [];

        if (isSearchMode) {
            if (isSearchMode) {
    const activeIssueResults = cachedSearchResults.filter(item =>
        item.statusCode === 1 ||
        item.statusCode === 2 ||
        item.statusCode === 3
    );

    if (currentTableType === 'all') {
        source = activeIssueResults;
    }

    if (currentTableType === 'critical') {
        source = activeIssueResults.filter(item => item.statusCode === 2);
    }

    if (currentTableType === 'warning') {
        source = activeIssueResults.filter(item => item.statusCode === 1);
    }

    if (currentTableType === 'unknown') {
        source = activeIssueResults.filter(item => item.statusCode === 3);
    }
}
        } else if (showAllStatusesForPoller) {
            source = [...cachedCritical, ...cachedWarning, ...cachedUnknown];
        } else {
            if (currentTableType === 'all') source = [...cachedCritical, ...cachedWarning, ...cachedUnknown];
            if (currentTableType === 'critical') source = cachedCritical;
            if (currentTableType === 'warning') source = cachedWarning;
            if (currentTableType === 'unknown') source = cachedUnknown;
        }

        return source.filter(item => {
            const matchHost =
                !filters.host ||
                item.host?.name?.toLowerCase().includes(filters.host.toLowerCase()) ||
                item.host?.display_name?.toLowerCase().includes(filters.host.toLowerCase()) ||
                item.host?.alias?.toLowerCase().includes(filters.host.toLowerCase());

            const matchService =
                !filters.service ||
                item.description?.toLowerCase().includes(filters.service.toLowerCase()) ||
                item.display_name?.toLowerCase().includes(filters.service.toLowerCase());

            const matchPoller =
                filters.poller === 'all' ||
                item.poller_name === filters.poller;

            return matchHost && matchService && matchPoller;
        });
    }, [
        isSearchMode,
        showAllStatusesForPoller,
        currentTableType,
        cachedSearchResults,
        cachedCritical,
        cachedWarning,
        cachedUnknown,
        filters
    ]);

    const filteredPollers = useMemo(() => {
        return cachedPollers.filter(p =>
            !pollerSearch ||
            p.Poller?.toLowerCase().includes(pollerSearch.toLowerCase())
        );
    }, [cachedPollers, pollerSearch]);

    const pollerFilteredServices = useMemo(() => {
        if (!selectedPoller) return [];

        let source = [];

        if (currentTableType === 'all') source = [...cachedCritical, ...cachedWarning, ...cachedUnknown];
        if (currentTableType === 'critical') source = cachedCritical;
        if (currentTableType === 'warning') source = cachedWarning;
        if (currentTableType === 'unknown') source = cachedUnknown;

        return source.filter(item => item.poller_name === selectedPoller);
    }, [selectedPoller, currentTableType, cachedCritical, cachedWarning, cachedUnknown]);

    // ============================================================
    // PAGINATION HELPERS
    // ============================================================
    const totalPages = useMemo(() => {
        return Math.max(1, Math.ceil((serviceMeta.total || 0) / serviceLimit));
    }, [serviceMeta.total, serviceLimit]);

    const visiblePageNumbers = useMemo(() => {
        const pages = [];
        const start = Math.max(1, servicePage - 2);
        const end = Math.min(totalPages, servicePage + 2);

        for (let page = start; page <= end; page++) {
            pages.push(page);
        }

        return pages;
    }, [servicePage, totalPages]);

    const goToPage = (page) => {
        const safePage = Math.min(Math.max(page, 1), totalPages);
        setServicePage(safePage);
    };

    const handlePageSizeChange = (e) => {
        setServiceLimit(Number(e.target.value));
        setServicePage(1);
    };

    // ============================================================
    // ACKNOWLEDGMENT SUBMISSION HANDLER
    // ============================================================
    const handleAcknowledge = async (hostName, serviceDescription) => {
        try {
            const token = localStorage.getItem('centreon_auth_token');

            const response = await fetch(`${BASE_API_URL}/api/centreon/acknowledge`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    host: hostName,
                    service: serviceDescription
                })
            });

            if (!response.ok) {
                throw new Error("Acknowledge network payload failed");
            }

            refreshDashboardData();

        } catch (error) {
            console.error("Failed to run safe exception acknowledgment:", error);
        }
    };

    const handleLogout = () => {
        localStorage.clear();
        navigate('/login');
    };

    return (
        <div className="app-container">
            {/* SIDEBAR NAVIGATION */}
            <aside className="sidebar">
                <div className="logo">
                    <span className="logo-icon">📊</span>
                    <span className="logo-text">GOC Dashboard</span>
                </div>

                <nav className="nav-menu">
                    <Link to="/dashboard" className={`nav-item ${location.pathname === '/dashboard' ? 'active' : ''}`}>
                        <span className="nav-icon">📊</span>
                        <span className="nav-text">Dashboard</span>
                    </Link>

                    <Link to="/pollers" className={`nav-item ${location.pathname === '/pollers' ? 'active' : ''}`}>
                        <span className="nav-icon">📡</span>
                        <span className="nav-text">Pollers</span>
                    </Link>

                    <Link to="/sla" className={`nav-item ${location.pathname === '/sla' ? 'active' : ''}`}>
                        <span className="nav-icon">📈</span>
                        <span className="nav-text">SLA Report</span>
                    </Link>

                    <Link to="/logs" className={`nav-item ${location.pathname === '/logs' ? 'active' : ''}`}>
                        <span className="nav-icon">📋</span>
                        <span className="nav-text">Audit Logs</span>
                    </Link>
                </nav>

                <div className="sidebar-footer">
                    <div className="refresh-info">🔄 Sync: {lastUpdated}</div>

                    <button className="logout-btn-sidebar" onClick={handleLogout}>
                        <span className="logout-text">Sign Out</span>
                    </button>
                </div>
            </aside>

            {/* MAIN CONTENT AREA */}
            <main className="main-content">
                <header className="content-header">
                    <h1>
                        {location.pathname === '/dashboard' && 'Dashboard Overview'}
                        {location.pathname === '/pollers' && 'Pollers Overview'}
                        {location.pathname === '/sla' && 'SLA Metrics'}
                        {location.pathname === '/logs' && 'System Audit Log'}
                    </h1>

                    <button className="refresh-btn" onClick={handleGlobalManualRefresh}>
                        Refresh Data
                    </button>
                </header>

                {/* STATS GRID */}
                {(location.pathname === '/dashboard' || location.pathname === '/pollers') && (
                    <div className="stats-grid" style={{ marginBottom: '24px' }}>
                        <div
                            className={`stat-card all ${currentTableType === 'all' ? 'active' : ''}`}
                            onClick={() => {
                                setCurrentTableType('all');
                                if (location.pathname === '/dashboard') setShowAllStatusesForPoller(true);
                            }}
                        >
                            <div className="stat-number">{displayCounts.allActiveIssues}</div>
                            <div className="stat-label">All Active Issues</div>
                        </div>

                        <div
                            className={`stat-card critical ${currentTableType === 'critical' ? 'active' : ''}`}
                            onClick={() => {
                                setCurrentTableType('critical');
                                if (location.pathname === '/dashboard') setShowAllStatusesForPoller(false);
                            }}
                        >
                            <div className="stat-number">{displayCounts.critical}</div>
                            <div className="stat-label">Critical</div>
                        </div>

                        <div
                            className={`stat-card warning ${currentTableType === 'warning' ? 'active' : ''}`}
                            onClick={() => {
                                setCurrentTableType('warning');
                                if (location.pathname === '/dashboard') setShowAllStatusesForPoller(false);
                            }}
                        >
                            <div className="stat-number">{displayCounts.warning}</div>
                            <div className="stat-label">Warning</div>
                        </div>

                        <div
                            className={`stat-card unknown ${currentTableType === 'unknown' ? 'active' : ''}`}
                            onClick={() => {
                                setCurrentTableType('unknown');
                                if (location.pathname === '/dashboard') setShowAllStatusesForPoller(false);
                            }}
                        >
                            <div className="stat-number">{displayCounts.unknown}</div>
                            <div className="stat-label">Unknown</div>
                        </div>
                    </div>
                )}

                {/* DASHBOARD OVERVIEW PANEL */}
                {location.pathname === '/dashboard' && (
                    <div className="page active">
                        <div className="top-row">
                            <div className="filter-section" style={{ width: '100%' }}>
                                <div className="filter-controls-vertical">
                                    <div className="filter-input-group">
                                        <label>HOST NODE</label>
                                        <input
                                            type="text"
                                            className="filter-input"
                                            placeholder="Filter host..."
                                            value={filters.host}
                                            onChange={(e) => setFilters(f => ({ ...f, host: e.target.value }))}
                                        />
                                    </div>

                                    <div className="filter-input-group">
                                        <label>SERVICE TARGET</label>
                                        <input
                                            type="text"
                                            className="filter-input"
                                            placeholder="Filter service..."
                                            value={filters.service}
                                            onChange={(e) => setFilters(f => ({ ...f, service: e.target.value }))}
                                        />
                                    </div>

                                    <div className="filter-input-group">
                                        <label>MONITORING ENGINE</label>
                                        <select
                                            className="filter-select"
                                            value={filters.poller}
                                            onChange={(e) => {
                                                setFilters(f => ({ ...f, poller: e.target.value }));
                                                setShowAllStatusesForPoller(false);
                                            }}
                                        >
                                            <option value="all">All Pollers</option>
                                            {pollerDropdownList.map(name => (
                                                <option key={name} value={name}>
                                                    {name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="services-section">
                            <div className="section-header">
                                <div className="section-header-left">
                                    <h2 className="section-title">
                                        {isSearchMode ? 'Search Results' : 'Active Exceptions'}
                                    </h2>
                                    <span className="service-count">
                                        {isLoadingServices ? 'Loading...' : `${filteredServices.length} Targets`}
                                    </span>
                                </div>
                            </div>

                            <div className="table-wrapper">
                                <table className="services-table">
                                    <thead>
                                        <tr>
                                            <th>Host</th>
                                            <th>Service</th>
                                            <th>Output Summary</th>
                                            <th>Status</th>
                                            <th>Acknowledged</th>
                                        </tr>
                                    </thead>

                                    <tbody>
                                        {filteredServices.length === 0 ? (
                                            <tr>
                                                <td colSpan="5" className="loading-cell">
                                                    {isLoadingServices
                                                        ? 'Loading services...'
                                                        : 'No services found matching current criteria.'}
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredServices.map((service, idx) => (
                                                <tr key={service.id || idx}>
                                                    <td className="host-name">
                                                        {service.host?.name || service.host?.display_name || 'N/A'}
                                                    </td>

                                                    <td className="service-name">
                                                        {service.description || service.display_name || 'N/A'}
                                                    </td>

                                                    <td className="service-output">
                                                        {service.output || 'No output details provided.'}
                                                    </td>

                                                    <td>
                                                        <span className={`status-text ${service.statusName?.toLowerCase()}`}>
                                                            {service.statusName}
                                                        </span>
                                                    </td>

                                                    <td className="ack-cell">
                                                        {service.is_acknowledged ? (
                                                            <span className="ack-badge">Acknowledged</span>
                                                        ) : (
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                                <span className="pending-badge">Pending</span>

                                                                <button
                                                                    className="ack-btn"
                                                                    onClick={() => handleAcknowledge(service.host?.name, service.description)}
                                                                    style={{
                                                                        background: '#238636',
                                                                        color: 'white',
                                                                        border: 'none',
                                                                        padding: '2px 8px',
                                                                        borderRadius: '4px',
                                                                        cursor: 'pointer',
                                                                        fontSize: '11px',
                                                                        fontWeight: 'bold'
                                                                    }}
                                                                >
                                                                    Ack
                                                                </button>
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            {/* PAGINATION CONTROLS */}
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '16px',
                                    marginTop: '16px',
                                    flexWrap: 'wrap'
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span>Page size:</span>
                                    <select
                                        className="filter-select"
                                        value={serviceLimit}
                                        onChange={handlePageSizeChange}
                                        disabled={isLoadingServices}
                                        style={{ width: '100px' }}
                                    >
                                        <option value={50}>50</option>
                                        <option value={100}>100</option>
                                        <option value={250}>250</option>
                                        <option value={500}>500</option>
                                    </select>
                                </div>

                                <div>
                                    Page {servicePage} of {totalPages}
                                    {' '}| Total Services: {serviceMeta.total || 0}
                                </div>

                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <button
                                        className="refresh-btn"
                                        disabled={servicePage <= 1 || isLoadingServices}
                                        onClick={() => goToPage(1)}
                                    >
                                        First
                                    </button>

                                    <button
                                        className="refresh-btn"
                                        disabled={servicePage <= 1 || isLoadingServices}
                                        onClick={() => goToPage(servicePage - 1)}
                                    >
                                        Previous
                                    </button>

                                    {visiblePageNumbers.map(page => (
                                        <button
                                            key={page}
                                            className="refresh-btn"
                                            disabled={isLoadingServices}
                                            onClick={() => goToPage(page)}
                                            style={{
                                                backgroundColor: page === servicePage ? '#238636' : undefined,
                                                color: page === servicePage ? 'white' : undefined
                                            }}
                                        >
                                            {page}
                                        </button>
                                    ))}

                                    <button
                                        className="refresh-btn"
                                        disabled={servicePage >= totalPages || isLoadingServices}
                                        onClick={() => goToPage(servicePage + 1)}
                                    >
                                        Next
                                    </button>

                                    <button
                                        className="refresh-btn"
                                        disabled={servicePage >= totalPages || isLoadingServices}
                                        onClick={() => goToPage(totalPages)}
                                    >
                                        Last
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* POLLERS PANEL */}
                {location.pathname === '/pollers' && (
                    <div className="page active">
                        <div className="pollers-container">
                            {!selectedPoller ? (
                                <>
                                    <div className="pollers-header">
                                        <h2>Engine Node Assignments</h2>

                                        <div className="search-bar">
                                            <input
                                                type="text"
                                                className="search-input"
                                                placeholder="Filter pollers by string name..."
                                                value={pollerSearch}
                                                onChange={(e) => setPollerSearch(e.target.value)}
                                            />
                                        </div>
                                    </div>

                                    <div className="pollers-table-wrapper">
                                        <table className="pollers-table">
                                            <thead>
                                                <tr>
                                                    <th>Instance Name</th>
                                                    <th>Monitored Items</th>
                                                    <th>Active Status Scope</th>
                                                </tr>
                                            </thead>

                                            <tbody>
                                                {filteredPollers.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="3" className="loading-cell">
                                                            No poller found matching search parameters.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    filteredPollers.map((p, idx) => (
                                                        <tr key={idx}>
                                                            <td
                                                                className="poller-name"
                                                                style={{ cursor: 'pointer', color: '#58a6ff' }}
                                                                onClick={() => setSelectedPoller(p.Poller)}
                                                            >
                                                                📁 {p.Poller || 'Unknown'}
                                                            </td>

                                                            <td className="total-count">
                                                                {p.Total || 0} items tracked
                                                            </td>

                                                            <td className="critical-count">
                                                                {p.Critical > 0 ? `⚠️ ${p.Critical} Outages Detected` : '🟢 Healthy'}
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                    <div className="table-count">
                                        Total Monitored Pollers: {filteredPollers.length}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="pollers-header">
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                            <button
                                                className="refresh-btn"
                                                onClick={() => setSelectedPoller(null)}
                                                style={{ backgroundColor: '#21262d', color: '#c9d1d9' }}
                                            >
                                                ⬅ Back to Pollers List
                                            </button>

                                            <h2>
                                                Poller: <span style={{ color: '#58a6ff' }}>{selectedPoller}</span>
                                            </h2>
                                        </div>

                                        <span
                                            className="service-count"
                                            style={{
                                                textTransform: 'uppercase',
                                                fontWeight: 'bold',
                                                color:
                                                    currentTableType === 'critical'
                                                        ? '#f85149'
                                                        : currentTableType === 'warning'
                                                            ? '#d29922'
                                                            : currentTableType === 'unknown'
                                                                ? '#58a6ff'
                                                                : '#c9d1d9'
                                            }}
                                        >
                                            {currentTableType} Status Exceptions ({pollerFilteredServices.length})
                                        </span>
                                    </div>

                                    <div className="table-wrapper">
                                        <table className="services-table">
                                            <thead>
                                                <tr>
                                                    <th>Host</th>
                                                    <th>Service</th>
                                                    <th>Output Summary</th>
                                                    <th>Status</th>
                                                    <th>Acknowledged</th>
                                                </tr>
                                            </thead>

                                            <tbody>
                                                {pollerFilteredServices.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="5" className="loading-cell">
                                                            No active {currentTableType} targets found under this poller.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    pollerFilteredServices.map((service, idx) => (
                                                        <tr key={service.id || idx}>
                                                            <td className="host-name">
                                                                {service.host?.name || service.host?.display_name || 'N/A'}
                                                            </td>

                                                            <td className="service-name">
                                                                {service.description || service.display_name || 'N/A'}
                                                            </td>

                                                            <td className="service-output">
                                                                {service.output || 'No output details provided.'}
                                                            </td>

                                                            <td>
                                                                <span className={`status-text ${service.statusName?.toLowerCase()}`}>
                                                                    {service.statusName}
                                                                </span>
                                                            </td>

                                                            <td className="ack-cell">
                                                                {service.is_acknowledged ? (
                                                                    <span className="ack-badge">Acknowledged</span>
                                                                ) : (
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                                        <span className="pending-badge">Pending</span>

                                                                        <button
                                                                            className="ack-btn"
                                                                            onClick={() => handleAcknowledge(service.host?.name, service.description)}
                                                                            style={{
                                                                                background: '#238636',
                                                                                color: 'white',
                                                                                border: 'none',
                                                                                padding: '2px 8px',
                                                                                borderRadius: '4px',
                                                                                cursor: 'pointer',
                                                                                fontSize: '11px',
                                                                                fontWeight: 'bold'
                                                                            }}
                                                                        >
                                                                            Ack
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                    <div className="table-count">
                                        Active Context Items: {pollerFilteredServices.length}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {/* SLA PANEL */}
                {location.pathname === '/sla' && <Sla />}

                {/* LOGS PANEL */}
                {location.pathname === '/logs' && <Logs />}
            </main>
        </div>
    );
}