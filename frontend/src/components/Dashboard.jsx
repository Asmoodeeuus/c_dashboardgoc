import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Sla from "./SLA";
import Logs from "./Logs";
import "../Dashboard.css";
import cevaLogo from "../assets/CEVA.png";

const BASE_API_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

const DataCenterContent = ({
    groups,
    counts,
    meta,
    loading,
    error,
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    page,
    setPage,
    limit,
    setLimit,
    selectedGroup,
    setSelectedGroup,
    detailPage,
    setDetailPage,
    detailLimit,
    setDetailLimit,
    detailFilter,
    setDetailFilter,
    onRefresh
}) => {
    const selectedHosts = selectedGroup?.hosts || [];

    const filteredDetailHosts = useMemo(() => {
        if (!selectedGroup) return [];

        if (detailFilter === 'critical') {
            return selectedHosts.filter(
                (host) => Number(host.counts?.critical || 0) > 0
            );
        }

        if (detailFilter === 'warning') {
            return selectedHosts.filter(
                (host) => Number(host.counts?.warning || 0) > 0
            );
        }

        if (detailFilter === 'unknown') {
            return selectedHosts.filter(
                (host) => Number(host.counts?.unknown || 0) > 0
            );
        }

        if (detailFilter === 'down') {
            return selectedHosts.filter(
                (host) => Number(host.state) === 1
            );
        }

        return selectedHosts;
    }, [selectedGroup, selectedHosts, detailFilter]);

    const totalDetailPages = Math.max(
        1,
        Math.ceil(filteredDetailHosts.length / detailLimit)
    );

    const paginatedDetailHosts = useMemo(() => {
        const start = (detailPage - 1) * detailLimit;
        return filteredDetailHosts.slice(start, start + detailLimit);
    }, [filteredDetailHosts, detailPage, detailLimit]);

    const downHostCount = selectedHosts.filter(
        (host) => Number(host.state) === 1
    ).length;

    const selectedCounts = selectedGroup?.counts || {
        allActiveIssues: 0,
        critical: 0,
        warning: 0,
        unknown: 0
    };

    const selectDetailFilter = (filter) => {
        setDetailFilter(filter);
        setDetailPage(1);
    };

    if (error) {
        return (
            <div className="data-center-error">
                <p>{error}</p>
                <button className="refresh-btn" onClick={onRefresh}>
                    Retry
                </button>
            </div>
        );
    }

    if (selectedGroup) {
        return (
            <div className="data-center-container">
                <div className="data-center-detail-header">
                    <button
                        className="refresh-btn"
                        onClick={() => {
                            setSelectedGroup(null);
                            setDetailPage(1);
                            setDetailFilter('all');
                        }}
                    >
                        Back to Host Groups
                    </button>
                    <h2>{selectedGroup.name}</h2>
                </div>

                <div className="stats-grid" style={{ marginBottom: '24px' }}>
                    <div
                        className={`stat-card all ${detailFilter === 'all' ? 'active' : ''}`}
                        onClick={() => selectDetailFilter('all')}
                    >
                        <div className="stat-number">
                            {selectedCounts.allActiveIssues || 0}
                        </div>
                        <div className="stat-label">All Service Issues</div>
                    </div>
                    <div
                        className={`stat-card critical ${detailFilter === 'critical' ? 'active' : ''}`}
                        onClick={() => selectDetailFilter('critical')}
                    >
                        <div className="stat-number">
                            {selectedCounts.critical || 0}
                        </div>
                        <div className="stat-label">Critical Services</div>
                    </div>
                    <div
                        className={`stat-card warning ${detailFilter === 'warning' ? 'active' : ''}`}
                        onClick={() => selectDetailFilter('warning')}
                    >
                        <div className="stat-number">
                            {selectedCounts.warning || 0}
                        </div>
                        <div className="stat-label">Warning Services</div>
                    </div>
                    <div
                        className={`stat-card unknown ${detailFilter === 'unknown' ? 'active' : ''}`}
                        onClick={() => selectDetailFilter('unknown')}
                    >
                        <div className="stat-number">
                            {selectedCounts.unknown || 0}
                        </div>
                        <div className="stat-label">Unknown Services</div>
                    </div>
                    <div
                        className={`stat-card critical ${detailFilter === 'down' ? 'active' : ''}`}
                        onClick={() => selectDetailFilter('down')}
                    >
                        <div className="stat-number">{downHostCount}</div>
                        <div className="stat-label">Down Hosts</div>
                    </div>
                </div>

                <div className="data-center-detail-controls-bottom">
                    <span>
                        {filteredDetailHosts.length} matching hosts
                    </span>
                    <select
                        className="data-center-page-size-select"
                        value={detailLimit}
                        onChange={(event) => {
                            setDetailLimit(Number(event.target.value));
                            setDetailPage(1);
                        }}
                    >
                        <option value="10">10</option>
                        <option value="20">20</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                        <option value="999999">All</option>
                    </select>
                    <button
                        className="data-center-page-btn"
                        onClick={() => setDetailPage((current) => Math.max(1, current - 1))}
                        disabled={detailPage <= 1}
                    >
                        Prev
                    </button>
                    <span>
                        Page {detailPage} of {totalDetailPages}
                    </span>
                    <button
                        className="data-center-page-btn"
                        onClick={() => setDetailPage((current) => Math.min(totalDetailPages, current + 1))}
                        disabled={detailPage >= totalDetailPages}
                    >
                        Next
                    </button>
                </div>

                <div className="data-center-table-wrapper">
                    <table className="data-center-detail-table">
                        <thead>
                            <tr>
                                <th>Host</th>
                                <th>Alias</th>
                                <th>Critical</th>
                                <th>Warning</th>
                                <th>Unknown</th>
                                <th>All Issues</th>
                                <th>State</th>
                            </tr>
                        </thead>
                        <tbody>
                            {paginatedDetailHosts.length === 0 ? (
                                <tr>
                                    <td colSpan="7" className="no-data">
                                        No hosts match the selected filter.
                                    </td>
                                </tr>
                            ) : (
                                paginatedDetailHosts.map((host) => (
                                    <tr key={host.id ?? host.name}>
                                        <td className="host-name">{host.name || 'N/A'}</td>
                                        <td>{host.alias || '-'}</td>
                                        <td className="critical-count">{host.counts?.critical || 0}</td>
                                        <td className="warning-count">{host.counts?.warning || 0}</td>
                                        <td className="unknown-count">{host.counts?.unknown || 0}</td>
                                        <td className="total-count">{host.counts?.allActiveIssues || 0}</td>
                                        <td>
                                            <span className={`host-status status-${host.state}`}>
                                                {Number(host.state) === 0 ? 'UP' :
                                                Number(host.state) === 1 ? 'DOWN' :
                                                Number(host.state) === 2 ? 'UNREACHABLE' :
                                                Number(host.state) === 3 ? 'PENDING' : 'UNKNOWN'}
                                            </span>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        );
    }

    return (
        <div className="data-center-container">
            <div className="top-row">
                <div className="filter-section-compact">
                    <div className="filter-controls-inline">
                        <div className="filter-input-group-compact">
                            <label>HOST GROUP</label>
                            <input
                                type="text"
                                className="filter-input-compact"
                                placeholder="Search host groups..."
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </div>
                        <div className="filter-input-group-compact">
                            <label>STATUS</label>
                            <select
                                className="filter-select-compact"
                                value={statusFilter}
                                onChange={(event) => {
                                    setStatusFilter(event.target.value);
                                    setPage(1);
                                }}
                            >
                                <option value="unhandled">Unhandled Problems</option>
                                <option value="acknowledged">Acknowledged</option>
                                <option value="all">All Active Problems</option>
                            </select>
                        </div>
                        <button className="refresh-btn" onClick={onRefresh} disabled={loading}>
                            {loading ? 'Refreshing...' : 'Refresh Data Center'}
                        </button>
                    </div>
                </div>
            </div>

            <div className="stats-grid" style={{ marginBottom: '24px' }}>
                <div className="stat-card all">
                    <div className="stat-number">{counts.allActiveIssues ?? '-'}</div>
                    <div className="stat-label">All Service Issues</div>
                </div>
                <div className="stat-card critical">
                    <div className="stat-number">{counts.critical ?? '-'}</div>
                    <div className="stat-label">Critical Services</div>
                </div>
                <div className="stat-card warning">
                    <div className="stat-number">{counts.warning ?? '-'}</div>
                    <div className="stat-label">Warning Services</div>
                </div>
                <div className="stat-card unknown">
                    <div className="stat-number">{counts.unknown ?? '-'}</div>
                    <div className="stat-label">Unknown Services</div>
                </div>
            </div>

            <div className="data-center-detail-controls-bottom">
                <span>
                    Host Groups: {meta.total || 0} | Unique Hosts: {counts.uniqueHosts || 0} | Hosts with Issues: {counts.hostsWithIssues || 0}
                </span>
                <select
                    className="data-center-page-size-select"
                    value={limit}
                    onChange={(event) => {
                        setLimit(Number(event.target.value));
                        setPage(1);
                    }}
                    disabled={loading}
                >
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                </select>
                <button
                    className="data-center-page-btn"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={loading || page <= 1}
                >
                    Prev
                </button>
                <span>Page {page} of {meta.totalPages || 1}</span>
                <button
                    className="data-center-page-btn"
                    onClick={() => setPage((current) => Math.min(meta.totalPages || 1, current + 1))}
                    disabled={loading || page >= (meta.totalPages || 1)}
                >
                    Next
                </button>
            </div>

            <div className="data-center-table-wrapper">
                <table className="data-center-table">
                    <thead>
                        <tr>
                            <th>Host Group</th>
                            <th>All Service Issues</th>
                            <th>Critical</th>
                            <th>Warning</th>
                            <th>Unknown</th>
                            <th>Hosts</th>
                            <th>Hosts with Issues</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr>
                                <td colSpan="7" className="loading-cell">
                                    Loading Data Center host groups...
                                </td>
                            </tr>
                        ) : groups.length === 0 ? (
                            <tr>
                                <td colSpan="7" className="no-data">
                                    No host groups found.
                                </td>
                            </tr>
                        ) : (
                            groups.map((group) => (
                                <tr
                                    key={group.id ?? group.name}
                                    className="data-center-row"
                                    onClick={() => {
                                        setSelectedGroup(group);
                                        setDetailPage(1);
                                        setDetailFilter('all');
                                    }}
                                >
                                    <td className="group-name">{group.name}</td>
                                    <td className="total-count">{group.counts?.allActiveIssues || 0}</td>
                                    <td className="critical-count">{group.counts?.critical || 0}</td>
                                    <td className="warning-count">{group.counts?.warning || 0}</td>
                                    <td className="unknown-count">{group.counts?.unknown || 0}</td>
                                    <td>{group.hostCount || 0}</td>
                                    <td>{group.hostsWithIssues || 0}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default function Dashboard() {
    const location = useLocation();
    const navigate = useNavigate();

    // --- SYSTEM TIME ---
    const [lastUpdated, setLastUpdated] = useState(new Date().toLocaleTimeString());

    // --- DASHBOARD LAYER STATE ---
    const [currentTableType, setCurrentTableType] = useState('all');
    const [filters, setFilters] = useState({ host: '', service: '', poller: 'all' });
    const [showAllStatusesForPoller, setShowAllStatusesForPoller] = useState(true);
    const [statusFilter, setStatusFilter] = useState('unhandled');

    // --- SERVICE PAGINATION STATE ---
    const [servicePage, setServicePage] = useState(1);
    const [serviceLimit, setServiceLimit] = useState(100);
    const [serviceMeta, setServiceMeta] = useState({
        page: 1,
        limit: 100,
        total: 0
    });
    const [isLoadingServices, setIsLoadingServices] = useState(false);

    // --- DASHBOARD PAGE-BASED COUNTS ---
    const [counts, setCounts] = useState({
        allActiveIssues: 0,
        critical: 0,
        warning: 0,
        unknown: 0
    });

    // --- DASHBOARD GLOBAL CACHED COUNTS ---
    const [globalDashboardCounts, setGlobalDashboardCounts] = useState({
        allActiveIssues: null,
        critical: null,
        warning: null,
        unknown: null
    });

    const [isRefreshingGlobalSummary, setIsRefreshingGlobalSummary] = useState(false);

    const [dashboardGlobalServices, setDashboardGlobalServices] = useState([]);
    const [dashboardGlobalMeta, setDashboardGlobalMeta] = useState({
        page: 1,
        limit: 100,
        total: 0,
        totalPages: 1
    });

    const [isLoadingDashboardGlobalList, setIsLoadingDashboardGlobalList] = useState(false);
    const [ackInProgressIds, setAckInProgressIds] = useState(new Set());
    const [unackInProgressIds, setUnackInProgressIds] = useState(new Set());

    // Prevent stale search/status requests from overwriting newer results.
    const dashboardGlobalListRequestIdRef = useRef(0);
    const dashboardSearchActiveRef = useRef(false);

    const [cachedCritical, setCachedCritical] = useState([]);
    const [cachedWarning, setCachedWarning] = useState([]);
    const [cachedUnknown, setCachedUnknown] = useState([]);
    const [cachedSearchResults, setCachedSearchResults] = useState([]);
    const [pollerDropdownList, setPollerDropdownList] = useState([]);

    // --- POLLERS PAGE STATE ---
    const [cachedPollers, setCachedPollers] = useState([]);
    const [pollerSearch, setPollerSearch] = useState('');
    const [selectedPoller, setSelectedPoller] = useState(null);
    const [selectedPollerId, setSelectedPollerId] = useState(null);

    const [pollerHosts, setPollerHosts] = useState([]);
    const [pollerHostPage, setPollerHostPage] = useState(1);
    const [pollerHostLimit, setPollerHostLimit] = useState(20);
    const [pollerHostMeta, setPollerHostMeta] = useState({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1
    });
    const [isLoadingPollerHosts, setIsLoadingPollerHosts] = useState(false);

    // --- SELECTED POLLER SERVICES STATE ---
    const [pollerServices, setPollerServices] = useState([]);
    const [isLoadingPollerServices, setIsLoadingPollerServices] = useState(false);

    const [pollerServiceCounts, setPollerServiceCounts] = useState({
        allActiveIssues: null,
        critical: null,
        warning: null,
        unknown: null
    });

    // --- GLOBAL SEARCH STATE ---
    const [debouncedHostSearch, setDebouncedHostSearch] = useState('');
    const [debouncedServiceSearch, setDebouncedServiceSearch] = useState('');

    // --- ACKNOWLEDGE MODAL STATE ---
    const [showAckModal, setShowAckModal] = useState(false);
    const [ackComment, setAckComment] = useState('');
    const [pendingAck, setPendingAck] = useState(null);
    // --- DATA CENTER STATE ---
    const [dataCenterGroups, setDataCenterGroups] = useState([]);
    const [dataCenterCounts, setDataCenterCounts] = useState({
        hostGroups: 0,
        uniqueHosts: 0,
        hostsWithIssues: 0,
        allActiveIssues: 0,
        critical: 0,
        warning: 0,
        unknown: 0
    });
    const [dataCenterMeta, setDataCenterMeta] = useState({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1
    });
    const [dataCenterPage, setDataCenterPage] = useState(1);
    const [dataCenterLimit, setDataCenterLimit] = useState(20);
    const [dataCenterSearch, setDataCenterSearch] = useState('');
    const [debouncedDataCenterSearch, setDebouncedDataCenterSearch] = useState('');
    const [dataCenterStatusFilter, setDataCenterStatusFilter] = useState('unhandled');
    const [dataCenterSelectedGroup, setDataCenterSelectedGroup] = useState(null);
    const [dataCenterDetailPage, setDataCenterDetailPage] = useState(1);
    const [dataCenterDetailLimit, setDataCenterDetailLimit] = useState(20);
    const [dataCenterDetailFilter, setDataCenterDetailFilter] = useState('all');
    const [dataCenterLoading, setDataCenterLoading] = useState(false);
    const [dataCenterError, setDataCenterError] = useState(null);
    const dataCenterRequestIdRef = useRef(0);
    const dataCenterRetryTimerRef = useRef(null);

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

    const getHostStateName = (host) => {
        const state = Number(host.state);

        if (state === 0) return 'UP';
        if (state === 1) return 'DOWN';
        if (state === 2) return 'UNREACHABLE';
        if (state === 3) return 'PENDING';

        return host.status?.name || 'UNKNOWN';
    };

    const getHostStateClass = (host) => {
        const stateName = getHostStateName(host);

        if (stateName === 'UP') return 'ok';
        if (stateName === 'DOWN') return 'critical';
        if (stateName === 'UNREACHABLE') return 'unknown';
        if (stateName === 'PENDING') return 'warning';

        return 'unknown';
    };

    const extractIpFromText = (text = '') => {
        const match = String(text).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        return match ? match[0] : null;
    };

    const isServiceAcknowledged = useCallback((service) => {
        const acknowledgement = service.acknowledgement;

        return Boolean(
            service.is_acknowledged === true ||
            service.is_acknowledged === 1 ||
            service.is_acknowledged === '1' ||
            service.is_acknowledged === 'true' ||
            service.acknowledged === true ||
            service.acknowledged === 1 ||
            service.acknowledged === '1' ||
            service.acknowledged === 'true' ||
            acknowledgement?.is_acknowledged === true ||
            acknowledgement?.is_acknowledged === 1 ||
            acknowledgement?.is_acknowledged === '1' ||
            acknowledgement?.is_acknowledged === 'true' ||
            Boolean(acknowledgement?.author) ||
            Boolean(acknowledgement?.comment) ||
            Boolean(acknowledgement?.entry_time)
        );
    }, []);

    const buildServiceCounts = useCallback((services, handlingFilter = 'unhandled') => {
        const handlingServices = services.filter((service) => {
            const acknowledged = isServiceAcknowledged(service);
            if (handlingFilter === 'acknowledged') return acknowledged;
            if (handlingFilter === 'all') return true;
            return !acknowledged;
        });

        const critical = handlingServices.filter(
            (service) => service.statusCode === 2
        ).length;
        const warning = handlingServices.filter(
            (service) => service.statusCode === 1
        ).length;
        const unknown = handlingServices.filter(
            (service) => service.statusCode === 3
        ).length;

        return {
            allActiveIssues: critical + warning + unknown,
            critical,
            warning,
            unknown
        };
    }, [isServiceAcknowledged]);

    // ============================================================
    // ROUTER RESET
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
            setSelectedPollerId(null);
            setPollerHosts([]);
            setPollerServices([]);
            setPollerServiceCounts({
                allActiveIssues: null,
                critical: null,
                warning: null,
                unknown: null
            });
        }
    }, [location, navigate]);

    // ============================================================
    // SEARCH DEBOUNCE
    // ============================================================
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedHostSearch(filters.host.trim());
            setServicePage(1);
        }, 500);

        return () => clearTimeout(timer);
    }, [filters.host]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedServiceSearch(filters.service.trim());
            setServicePage(1);
        }, 500);

        return () => clearTimeout(timer);
    }, [filters.service]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedDataCenterSearch(dataCenterSearch.trim());
            setDataCenterPage(1);
        }, 500);
        return () => clearTimeout(timer);
    }, [dataCenterSearch]);

    useEffect(() => {
        dashboardSearchActiveRef.current =
            location.pathname === '/dashboard' &&
            filters.poller === 'all' &&
            Boolean(debouncedHostSearch || debouncedServiceSearch);
    }, [
        location.pathname,
        filters.poller,
        debouncedHostSearch,
        debouncedServiceSearch
    ]);

    // ============================================================
    // GLOBAL DASHBOARD SUMMARY FETCH
    // ============================================================
    const fetchGlobalDashboardSummary = useCallback(async (shouldUpdateCards = true) => {
        try {
            const token = localStorage.getItem('centreon_auth_token');

            const response = await fetch(
                `${BASE_API_URL}/api/centreon/services/status/global-summary`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }

            const payload = await response.json();

            setIsRefreshingGlobalSummary(Boolean(payload.refreshing));

            if (
                shouldUpdateCards &&
                !dashboardSearchActiveRef.current &&
                payload.counts &&
                payload.cached
            ) {
                setGlobalDashboardCounts({
                    allActiveIssues: payload.counts.allActiveIssues,
                    critical: payload.counts.critical,
                    warning: payload.counts.warning,
                    unknown: payload.counts.unknown
                });
            }

            if (payload.meta?.cacheRefreshing && !payload.meta?.cacheFresh) {
                setTimeout(() => {
                    if (!dashboardSearchActiveRef.current) {
                        fetchGlobalDashboardSummary(shouldUpdateCards);
                    }
                }, 10000);
            }

        } catch (error) {
            console.error("Error fetching global dashboard summary:", error);
        }
    }, []);

    const fetchDashboardGlobalServiceList = useCallback(async (
        type = 'all',
        page = 1,
        limit = 100,
        hostSearch = '',
        serviceSearch = '',
        statusFilterParam = 'unhandled'
    ) => {
        const requestId = dashboardGlobalListRequestIdRef.current + 1;
        dashboardGlobalListRequestIdRef.current = requestId;

        const isLatestRequest = () => dashboardGlobalListRequestIdRef.current === requestId;

        try {
            setIsLoadingDashboardGlobalList(true);

            // Clear stale table data while switching cards/status.
            setDashboardGlobalServices([]);
            setDashboardGlobalMeta({
                page,
                limit,
                total: 0,
                totalPages: 1
            });

            const token = localStorage.getItem('centreon_auth_token');

            const params = new URLSearchParams({
                type,
                page: String(page),
                limit: String(limit),
                statusFilter: statusFilterParam
            });

            if (hostSearch) {
                params.set('host', hostSearch);
            }

            if (serviceSearch) {
                params.set('service', serviceSearch);
            }

            const response = await fetch(
                `${BASE_API_URL}/api/centreon/services/status/global-summary/list?${params.toString()}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }

            const payload = await response.json();

            if (!isLatestRequest()) {
                return;
            }

            setIsRefreshingGlobalSummary(Boolean(payload.refreshing));

            const rawResults = payload.data?.result || [];
            const uniqueMap = new Map();

            rawResults.forEach(service => {
                const serviceKey = String(
                    service.id ??
                    service.service_id ??
                    `${service.host?.id || service.host?.name || 'host'}-${service.description || service.display_name || 'service'}`
                );

                uniqueMap.set(serviceKey, service);
            });

            const uniqueResults = Array.from(uniqueMap.values());

            const shouldRetryList =
                payload.refreshing === true ||
                payload.meta?.cacheRefreshing === true ||
                payload.cached === false ||
                payload.meta?.cacheLoaded === false;

            if (payload.cached) {
                const hasSearch = Boolean(hostSearch || serviceSearch);

                const countSource =
                    hasSearch && payload.filteredCounts
                        ? payload.filteredCounts
                        : payload.counts;

                if (countSource) {
                    setGlobalDashboardCounts({
                        allActiveIssues: countSource.allActiveIssues,
                        critical: countSource.critical,
                        warning: countSource.warning,
                        unknown: countSource.unknown
                    });
                }
            }

            setDashboardGlobalServices(uniqueResults);

            setDashboardGlobalMeta(payload.meta || {
                page,
                limit,
                total: uniqueResults.length,
                totalPages: 1
            });

            if (shouldRetryList) {
                setTimeout(() => {
                    if (isLatestRequest()) {
                        fetchDashboardGlobalServiceList(
                            type,
                            page,
                            limit,
                            hostSearch,
                            serviceSearch,
                            statusFilterParam
                        );
                    }
                }, 10000);
            }

        } catch (error) {
            if (!isLatestRequest()) {
                return;
            }

            console.error("Error fetching dashboard global service list:", error);

            setDashboardGlobalServices([]);
            setDashboardGlobalMeta({
                page,
                limit,
                total: 0,
                totalPages: 1
            });

        } finally {
            if (isLatestRequest()) {
                setIsLoadingDashboardGlobalList(false);
            }
        }
    }, []);

    const fetchDataCenterHostGroups = useCallback(async ({ background = false } = {}) => {
        const requestId = dataCenterRequestIdRef.current + 1;
        dataCenterRequestIdRef.current = requestId;
        const isLatestRequest = () => dataCenterRequestIdRef.current === requestId;

        if (dataCenterRetryTimerRef.current) {
            clearTimeout(dataCenterRetryTimerRef.current);
            dataCenterRetryTimerRef.current = null;
        }

        try {
            if (!background) setDataCenterLoading(true);
            setDataCenterError(null);

            const token = localStorage.getItem('centreon_auth_token');
            const params = new URLSearchParams({
                page: String(dataCenterPage),
                limit: String(dataCenterLimit),
                statusFilter: dataCenterStatusFilter,
                search: debouncedDataCenterSearch,
                includeHosts: 'true'
            });

            const response = await fetch(
                `${BASE_API_URL}/api/centreon/datacenter/hostgroups?${params.toString()}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                throw new Error(
                    payload?.message ||
                    `Data Center request failed with HTTP ${response.status}`
                );
            }

            if (!isLatestRequest()) return;

            setDataCenterGroups(payload?.data?.result || []);
            setDataCenterCounts(payload?.counts || {
                hostGroups: 0,
                uniqueHosts: 0,
                hostsWithIssues: 0,
                allActiveIssues: 0,
                critical: 0,
                warning: 0,
                unknown: 0
            });
            setDataCenterMeta(payload?.meta || {
                page: dataCenterPage,
                limit: dataCenterLimit,
                total: 0,
                totalPages: 1
            });
            setLastUpdated(new Date().toLocaleTimeString());

            const shouldRetry =
                payload?.cached === false ||
                payload?.meta?.cacheLoaded === false ||
                payload?.meta?.cacheRefreshing === true;

            if (shouldRetry) {
                dataCenterRetryTimerRef.current = setTimeout(() => {
                    if (isLatestRequest()) {
                        fetchDataCenterHostGroups({ background: true });
                    }
                }, 10000);
            }
        } catch (error) {
            if (!isLatestRequest()) return;
            console.error('Error fetching Data Center host groups:', error);
            setDataCenterError(error.message);
        } finally {
            if (isLatestRequest() && !background) {
                setDataCenterLoading(false);
            }
        }
    }, [
        dataCenterPage,
        dataCenterLimit,
        dataCenterStatusFilter,
        debouncedDataCenterSearch
    ]);

    // ============================================================
    // DASHBOARD FETCH
    // ============================================================
    const refreshDashboardData = useCallback(async () => {
        const usingDashboardGlobalCache =
            location.pathname === '/dashboard' &&
            filters.poller === 'all';

        const hasDashboardSearch = Boolean(debouncedHostSearch || debouncedServiceSearch);

        try {
            if (usingDashboardGlobalCache) {
                setIsLoadingServices(false);
            } else {
                setIsLoadingServices(true);
            }

            fetchGlobalDashboardSummary(
                statusFilter === 'unhandled' &&
                !(usingDashboardGlobalCache && hasDashboardSearch)
            );

            const token = localStorage.getItem('centreon_auth_token');

            const fetchOptions = {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            };

            if (usingDashboardGlobalCache) {
                const hostsRes = await fetch(
                    `${BASE_API_URL}/api/centreon/hosts/status/all`,
                    fetchOptions
                );

                if (!hostsRes.ok) {
                    throw new Error("Hosts API payload error");
                }

                const hostsPayload = await hostsRes.json();
                const rawHosts = hostsPayload.data?.result || [];
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

                return;
            }

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

            const unhandledCritical = criticals.filter(service => !isServiceAcknowledged(service)).length;
            const unhandledWarning = warnings.filter(service => !isServiceAcknowledged(service)).length;
            const unhandledUnknown = unknowns.filter(service => !isServiceAcknowledged(service)).length;

            setCounts({
                allActiveIssues: unhandledCritical + unhandledWarning + unhandledUnknown,
                critical: unhandledCritical,
                warning: unhandledWarning,
                unknown: unhandledUnknown
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
            if (!usingDashboardGlobalCache) {
                setIsLoadingServices(false);
            }
        }
    }, [
        location.pathname,
        filters.poller,
        debouncedHostSearch,
        debouncedServiceSearch,
        servicePage,
        serviceLimit,
        fetchGlobalDashboardSummary,
        isServiceAcknowledged,
        statusFilter
    ]);

    // ============================================================
    // POLLERS FETCH
    // ============================================================
    const fetchPollersRoster = useCallback(async () => {
        try {
            const token = localStorage.getItem('centreon_auth_token');

            const response = await fetch(`${BASE_API_URL}/api/centreon/pollers`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("Pollers endpoint failed:", response.status, errorText);
                throw new Error(`HTTP Error ${response.status}`);
            }

            const payload = await response.json();

            const rawPollers =
                payload.data?.result ||
                payload.result ||
                [];

            const mappedPollers = rawPollers.map(poller => ({
                Poller: poller.poller_name || `Poller ${poller.poller_id}`,
                poller_id: poller.poller_id,
                Address: poller.address || 'N/A',
                ServerType: poller.server_type || 'N/A',
                Total: poller.totalHosts ?? null,
                Critical: poller.downHosts ?? null,
                Warning: poller.pendingHosts ?? null,
                Unknown: poller.unreachableHosts ?? null,
                upHosts: poller.upHosts ?? null,
                downHosts: poller.downHosts ?? null,
                unreachableHosts: poller.unreachableHosts ?? null,
                pendingHosts: poller.pendingHosts ?? null
            }));

            setCachedPollers(mappedPollers);

        } catch (error) {
            console.error('Error fetching pollers roster:', error);
            setCachedPollers([]);
        }
    }, []);

    const fetchServicesForVisibleHosts = useCallback(async (hosts) => {
        try {
            setIsLoadingPollerServices(true);

            const token = localStorage.getItem('centreon_auth_token');

            const hostsWithIds = hosts
                .map(host => ({
                    host,
                    hostId: host.id ?? host.host_id
                }))
                .filter(item => item.hostId !== undefined && item.hostId !== null);

            if (hostsWithIds.length === 0) {
                setPollerServices([]);
                setPollerServiceCounts({
                    allActiveIssues: 0,
                    critical: 0,
                    warning: 0,
                    unknown: 0
                });
                return;
            }

            const results = await Promise.all(
                hostsWithIds.map(async ({ host, hostId }) => {
                    try {
                        const response = await fetch(`${BASE_API_URL}/api/centreon/services/host/${hostId}`, {
                            headers: {
                                'Authorization': `Bearer ${token}`
                            }
                        });

                        if (!response.ok) {
                            throw new Error(`HTTP Error ${response.status}`);
                        }

                        const payload = await response.json();

                        return (payload.data?.result || []).map(service => normalizeService({
                            ...service,
                            host: service.host || {
                                id: hostId,
                                name: host.name,
                                display_name: host.display_name,
                                alias: host.alias,
                                poller_id: host.poller_id,
                                poller_name: host.poller_name
                            }
                        }));

                    } catch (error) {
                        console.warn("Failed loading services for host:", hostId, error);
                        return [];
                    }
                })
            );

            const allServices = results.flat();

            const activeIssueServices = allServices.filter(service =>
                service.statusCode === 1 ||
                service.statusCode === 2 ||
                service.statusCode === 3
            );

            setPollerServices(activeIssueServices);
            setPollerServiceCounts(buildServiceCounts(activeIssueServices));

        } catch (error) {
            console.error("Error loading services for visible poller hosts:", error);
            setPollerServices([]);
            setPollerServiceCounts({
                allActiveIssues: 0,
                critical: 0,
                warning: 0,
                unknown: 0
            });
        } finally {
            setIsLoadingPollerServices(false);
        }
    }, [buildServiceCounts]);

    const fetchPollerHosts = useCallback(async (pollerId, page = 1, limit = pollerHostLimit) => {
        try {
            if (!pollerId) return;

            setIsLoadingPollerHosts(true);
            setIsLoadingPollerServices(true);

            const token = localStorage.getItem('centreon_auth_token');

            const response = await fetch(
                `${BASE_API_URL}/api/centreon/pollers/${pollerId}/hosts?page=${page}&limit=${limit}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }

            const payload = await response.json();

            const returnedHosts = payload.data?.result || [];

            setPollerHosts(returnedHosts);
            setPollerHostMeta(payload.meta || {
                page,
                limit,
                total: 0,
                totalPages: 1
            });

            if (payload.meta?.hostCacheRefreshing && !payload.meta?.hostCacheLoaded) {
                setPollerServices([]);
                setPollerServiceCounts({
                    allActiveIssues: null,
                    critical: null,
                    warning: null,
                    unknown: null
                });

                setTimeout(() => {
                    fetchPollerHosts(pollerId, page, limit);
                }, 5000);

                return;
            }

            if (returnedHosts.length > 0) {
                await fetchServicesForVisibleHosts(returnedHosts);
            } else {
                setPollerServices([]);
                setPollerServiceCounts({
                    allActiveIssues: 0,
                    critical: 0,
                    warning: 0,
                    unknown: 0
                });
                setIsLoadingPollerServices(false);
            }

        } catch (error) {
            console.error('Error fetching poller hosts:', error);
            setPollerServices([]);
            setPollerServiceCounts({
                allActiveIssues: 0,
                critical: 0,
                warning: 0,
                unknown: 0
            });
            setIsLoadingPollerServices(false);
        } finally {
            setIsLoadingPollerHosts(false);
        }
    }, [pollerHostLimit, fetchServicesForVisibleHosts]);

    // ============================================================
    // MANUAL REFRESH
    // ============================================================
    const handleGlobalManualRefresh = () => {
        refreshDashboardData();
        fetchPollersRoster();

        if (location.pathname === '/dashboard' && filters.poller === 'all') {
            fetchDashboardGlobalServiceList(
                currentTableType,
                servicePage,
                serviceLimit,
                debouncedHostSearch,
                debouncedServiceSearch,
                statusFilter
            );
        }

        if (selectedPollerId) {
            fetchPollerHosts(
                selectedPollerId,
                pollerHostPage,
                pollerHostLimit
            );
        }

        if (location.pathname === '/datacenter') {
            fetchDataCenterHostGroups();
        }
    };

    // ============================================================
    // LIFECYCLE
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

            if (selectedPollerId) {
                fetchPollerHosts(selectedPollerId, pollerHostPage, pollerHostLimit);
            }
            if (location.pathname === '/datacenter') {
                fetchDataCenterHostGroups({ background: true });
            }
        }, 300000);

        return () => clearInterval(heartbeat);
    }, [
        refreshDashboardData,
        fetchPollersRoster,
        fetchPollerHosts,
        selectedPollerId,
        pollerHostPage,
        pollerHostLimit,
        location.pathname,
        navigate,
        fetchDataCenterHostGroups
    ]);

    useEffect(() => {
        if (location.pathname === '/datacenter') {
            fetchDataCenterHostGroups();
        }
    }, [location.pathname, fetchDataCenterHostGroups]);

    useEffect(() => {
        return () => {
            dataCenterRequestIdRef.current += 1;
            if (dataCenterRetryTimerRef.current) {
                clearTimeout(dataCenterRetryTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (location.pathname === '/pollers' && selectedPollerId) {
            fetchPollerHosts(selectedPollerId, pollerHostPage, pollerHostLimit);
        }
    }, [location.pathname, selectedPollerId, pollerHostPage, pollerHostLimit, fetchPollerHosts]);

    // ============================================================
    // MEMOIZED DATA
    // ============================================================
    const activePollerContext = useMemo(() => {
        if (location.pathname === '/dashboard') return filters.poller;
        if (location.pathname === '/pollers') return selectedPoller || 'all';
        return 'all';
    }, [location.pathname, filters.poller, selectedPoller]);

    const dashboardGlobalListMode = useMemo(() => {
        return (
            location.pathname === '/dashboard' &&
            filters.poller === 'all'
        );
    }, [
        location.pathname,
        filters.poller
    ]);

    useEffect(() => {
        if (!dashboardGlobalListMode) {
            dashboardGlobalListRequestIdRef.current += 1;
            setIsLoadingDashboardGlobalList(false);
        }
    }, [dashboardGlobalListMode]);

    useEffect(() => {
        if (dashboardGlobalListMode) {
            fetchDashboardGlobalServiceList(
                currentTableType,
                servicePage,
                serviceLimit,
                debouncedHostSearch,
                debouncedServiceSearch,
                statusFilter
            );
        }
    }, [
        dashboardGlobalListMode,
        currentTableType,
        servicePage,
        serviceLimit,
        debouncedHostSearch,
        debouncedServiceSearch,
        statusFilter,
        fetchDashboardGlobalServiceList
    ]);

    const filteredPollers = useMemo(() => {
        const search = pollerSearch.toLowerCase().trim();

        return cachedPollers.filter(p =>
            !search ||
            p.Poller?.toLowerCase().includes(search) ||
            String(p.poller_id || '').includes(search)
        );
    }, [cachedPollers, pollerSearch]);

    const displayCounts = useMemo(() => {
        if (location.pathname === '/pollers' && selectedPollerId) {
            return buildServiceCounts(pollerServices, statusFilter);
        }

        if (location.pathname === '/dashboard' && activePollerContext === 'all') {
            return {
                allActiveIssues: globalDashboardCounts.allActiveIssues ?? counts.allActiveIssues,
                critical: globalDashboardCounts.critical ?? counts.critical,
                warning: globalDashboardCounts.warning ?? counts.warning,
                unknown: globalDashboardCounts.unknown ?? counts.unknown
            };
        }

        if (activePollerContext !== 'all') {
            const services = [
                ...cachedCritical,
                ...cachedWarning,
                ...cachedUnknown
            ].filter((service) => service.poller_name === activePollerContext);

            return buildServiceCounts(services, statusFilter);
        }

        return counts;
    }, [
        location.pathname,
        selectedPollerId,
        pollerServices,
        statusFilter,
        activePollerContext,
        globalDashboardCounts,
        counts,
        cachedCritical,
        cachedWarning,
        cachedUnknown,
        buildServiceCounts
    ]);

    const isSearchMode = Boolean(debouncedHostSearch || debouncedServiceSearch);

    const filteredServices = useMemo(() => {
        let source = [];

        if (isSearchMode) {
            const activeIssueResults = cachedSearchResults.filter(item =>
                item.statusCode === 1 ||
                item.statusCode === 2 ||
                item.statusCode === 3
            );

            if (currentTableType === 'all') source = activeIssueResults;
            if (currentTableType === 'critical') source = activeIssueResults.filter(item => item.statusCode === 2);
            if (currentTableType === 'warning') source = activeIssueResults.filter(item => item.statusCode === 1);
            if (currentTableType === 'unknown') source = activeIssueResults.filter(item => item.statusCode === 3);
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

            const matchUnhandled = !isServiceAcknowledged(item);

            return matchHost && matchService && matchPoller && matchUnhandled;
        });
    }, [
        isSearchMode,
        showAllStatusesForPoller,
        currentTableType,
        cachedSearchResults,
        cachedCritical,
        cachedWarning,
        cachedUnknown,
        filters,
        statusFilter,
        isServiceAcknowledged
    ]);

    const dashboardTableServices = useMemo(() => {
        const source = dashboardGlobalListMode
            ? dashboardGlobalServices
            : filteredServices;

        return source.filter((service) => {
            const acknowledged = isServiceAcknowledged(service);
            if (statusFilter === 'acknowledged') return acknowledged;
            if (statusFilter === 'all') return true;
            return !acknowledged;
        });
    }, [
        dashboardGlobalListMode,
        dashboardGlobalServices,
        filteredServices,
        statusFilter,
        isServiceAcknowledged
    ]);

    const filteredPollerServices = useMemo(() => {
        let services = pollerServices;

        if (currentTableType === 'critical') {
            services = services.filter((service) => service.statusCode === 2);
        } else if (currentTableType === 'warning') {
            services = services.filter((service) => service.statusCode === 1);
        } else if (currentTableType === 'unknown') {
            services = services.filter((service) => service.statusCode === 3);
        }

        return services.filter((service) => {
            const acknowledged = isServiceAcknowledged(service);
            if (statusFilter === 'acknowledged') return acknowledged;
            if (statusFilter === 'all') return true;
            return !acknowledged;
        });
    }, [
        pollerServices,
        currentTableType,
        statusFilter,
        isServiceAcknowledged
    ]);

    // ============================================================
    // PAGINATION HELPERS
    // ============================================================
    const totalPages = useMemo(() => {
        if (dashboardGlobalListMode) {
            return Math.max(1, dashboardGlobalMeta.totalPages || 1);
        }

        return Math.max(1, Math.ceil((serviceMeta.total || 0) / serviceLimit));
    }, [
        dashboardGlobalListMode,
        dashboardGlobalMeta.totalPages,
        serviceMeta.total,
        serviceLimit
    ]);

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

    const handlePollerPageSizeChange = (e) => {
        setPollerHostLimit(Number(e.target.value));
        setPollerHostPage(1);
    };

    // ============================================================
    // ACKNOWLEDGMENT / UNACKNOWLEDGMENT / LOGOUT
    // ============================================================
    const getAckKey = (hostName, serviceDescription, hostId = null, serviceId = null) => {
        return String(
            serviceId ??
            `${hostId || ''}-${hostName || ''}-${serviceDescription || ''}`
        );
    };

    const markServiceAsAcknowledged = useCallback((hostName, serviceDescription, hostId = null, serviceId = null) => {
        const matchesService = (service) => {
            const currentServiceId = service.id;
            const currentHostId = service.host?.id;

            const currentHostName =
                service.host?.name ||
                service.host?.display_name ||
                '';

            const currentServiceDescription =
                service.description ||
                service.display_name ||
                '';

            if (serviceId !== null && serviceId !== undefined) {
                return String(currentServiceId) === String(serviceId);
            }

            if (hostId !== null && hostId !== undefined) {
                return (
                    String(currentHostId) === String(hostId) &&
                    currentServiceDescription === serviceDescription
                );
            }

            return (
                currentHostName === hostName &&
                currentServiceDescription === serviceDescription
            );
        };

        const patchService = (service) => {
            if (!matchesService(service)) {
                return service;
            }

            return {
                ...service,
                is_acknowledged: true,
                acknowledged: true,
                acknowledgement: {
                    ...(typeof service.acknowledgement === 'object' ? service.acknowledgement : {}),
                    is_acknowledged: true,
                    comment: service.acknowledgement?.comment || 'Acknowledged from GOC Dashboard'
                }
            };
        };

        setDashboardGlobalServices(prev => prev.map(patchService));
        setPollerServices(prev => prev.map(patchService));
        setCachedCritical(prev => prev.map(patchService));
        setCachedWarning(prev => prev.map(patchService));
        setCachedUnknown(prev => prev.map(patchService));
        setCachedSearchResults(prev => prev.map(patchService));
    }, []);

    const markServiceAsUnacknowledged = useCallback((hostName, serviceDescription, hostId = null, serviceId = null) => {
        const matchesService = (service) => {
            const currentServiceId = service.id;
            const currentHostId = service.host?.id;

            const currentHostName =
                service.host?.name ||
                service.host?.display_name ||
                '';

            const currentServiceDescription =
                service.description ||
                service.display_name ||
                '';

            if (serviceId !== null && serviceId !== undefined) {
                return String(currentServiceId) === String(serviceId);
            }

            if (hostId !== null && hostId !== undefined) {
                return (
                    String(currentHostId) === String(hostId) &&
                    currentServiceDescription === serviceDescription
                );
            }

            return (
                currentHostName === hostName &&
                currentServiceDescription === serviceDescription
            );
        };

        const patchService = (service) => {
            if (!matchesService(service)) {
                return service;
            }

            return {
                ...service,
                is_acknowledged: false,
                acknowledged: false,
                acknowledgement: null
            };
        };

        setDashboardGlobalServices(prev => prev.map(patchService));
        setPollerServices(prev => prev.map(patchService));
        setCachedCritical(prev => prev.map(patchService));
        setCachedWarning(prev => prev.map(patchService));
        setCachedUnknown(prev => prev.map(patchService));
        setCachedSearchResults(prev => prev.map(patchService));
    }, []);

    const handleAcknowledge = async (
    hostName,
    serviceDescription,
    hostId = null,
    serviceId = null,
    hostAddress = null,
    customComment = null
) => {
    const ackKey = getAckKey(
        hostName,
        serviceDescription,
        hostId,
        serviceId
    );

    try {
        setAckInProgressIds(prev => {
            const next = new Set(prev);
            next.add(ackKey);
            return next;
        });

        const token = localStorage.getItem(
            'centreon_auth_token'
        );

        const payload = {
            host: hostName,
            service: serviceDescription,
            hostId,
            serviceId,
            hostAddress
        };

        if (customComment) {
            payload.comment = customComment;
        }

        const response = await fetch(
            `${BASE_API_URL}/api/centreon/acknowledge`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            }
        );

        const result = await response.json().catch(() => null);

        if (!response.ok) {
            throw new Error(
                result?.message ||
                `Acknowledge failed with HTTP ${response.status}`
            );
        }

        markServiceAsAcknowledged(
            hostName,
            serviceDescription,
            hostId,
            serviceId
        );

        /*
         * Apply the backend's recalculated global counts immediately,
         * but only when there is no active Dashboard search.
         *
         * During search mode, the list request below will provide the
         * correct filteredCounts instead.
         */
        if (
            result?.updatedCounts &&
            statusFilter === 'unhandled' &&
            !dashboardSearchActiveRef.current
        ) {
            setGlobalDashboardCounts({
                allActiveIssues:
                    result.updatedCounts.allActiveIssues,
                critical:
                    result.updatedCounts.critical,
                warning:
                    result.updatedCounts.warning,
                unknown:
                    result.updatedCounts.unknown
            });
        }

        setLastUpdated(
            new Date().toLocaleTimeString()
        );

        /*
         * Global Dashboard:
         * Reload the current severity, page, and search.
         */
        if (dashboardGlobalListMode) {
            await fetchDashboardGlobalServiceList(
                currentTableType,
                servicePage,
                serviceLimit,
                debouncedHostSearch,
                debouncedServiceSearch,
                statusFilter
            );

            return;
        }

        /*
         * Pollers page:
         * Reload the selected Poller so service state and local
         * Poller counts remain synchronized.
         */
        if (
            location.pathname === '/pollers' &&
            selectedPollerId
        ) {
            await fetchPollerHosts(
                selectedPollerId,
                pollerHostPage,
                pollerHostLimit
            );

            return;
        }

        /*
         * Dashboard with a specific Poller filter:
         * Reload the normal Dashboard data.
         */
        await refreshDashboardData();

    } catch (error) {
        console.error(
            "Failed to run safe exception acknowledgment:",
            error
        );
    } finally {
        setAckInProgressIds(prev => {
            const next = new Set(prev);
            next.delete(ackKey);
            return next;
        });
    }
};

    const handleUnacknowledge = async (
    hostName,
    serviceDescription,
    hostId = null,
    serviceId = null,
    hostAddress = null
) => {
    const ackKey = getAckKey(
        hostName,
        serviceDescription,
        hostId,
        serviceId
    );

    try {
        setUnackInProgressIds(prev => {
            const next = new Set(prev);
            next.add(ackKey);
            return next;
        });

        const token = localStorage.getItem(
            'centreon_auth_token'
        );

        const response = await fetch(
            `${BASE_API_URL}/api/centreon/unacknowledge`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    host: hostName,
                    service: serviceDescription,
                    hostId,
                    serviceId,
                    hostAddress
                })
            }
        );

        const result = await response.json().catch(() => null);

        if (!response.ok) {
            throw new Error(
                result?.message ||
                `Unacknowledge failed with HTTP ${response.status}`
            );
        }

        markServiceAsUnacknowledged(
            hostName,
            serviceDescription,
            hostId,
            serviceId
        );

        /*
         * Update global Dashboard counts immediately only when
         * there is no active Dashboard search.
         */
        if (
            result?.updatedCounts &&
            statusFilter === 'unhandled' &&
            !dashboardSearchActiveRef.current
        ) {
            setGlobalDashboardCounts({
                allActiveIssues:
                    result.updatedCounts.allActiveIssues,
                critical:
                    result.updatedCounts.critical,
                warning:
                    result.updatedCounts.warning,
                unknown:
                    result.updatedCounts.unknown
            });
        }

        setLastUpdated(
            new Date().toLocaleTimeString()
        );

        /*
         * Pollers is currently where acknowledged services
         * can be unacknowledged. Reload the selected Poller.
         */
        if (
            location.pathname === '/pollers' &&
            selectedPollerId
        ) {
            await fetchPollerHosts(
                selectedPollerId,
                pollerHostPage,
                pollerHostLimit
            );

            return;
        }

        /*
         * This branch supports future UNACK actions directly
         * from the global Dashboard.
         */
        if (dashboardGlobalListMode) {
            await fetchDashboardGlobalServiceList(
                currentTableType,
                servicePage,
                serviceLimit,
                debouncedHostSearch,
                debouncedServiceSearch,
                statusFilter
            );

            return;
        }

        await refreshDashboardData();

    } catch (error) {
        console.error(
            "Failed to run safe unacknowledgement:",
            error
        );
    } finally {
        setUnackInProgressIds(prev => {
            const next = new Set(prev);
            next.delete(ackKey);
            return next;
        });
    }
};

    const handleLogout = () => {
        localStorage.clear();
        navigate('/login');
    };

    return (
        <div className="app-container">
            <aside className="sidebar">
                <div className="logo">
                    <img src={cevaLogo} alt="CEVA Logo" className="logo-image" />
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

                    <Link to="/datacenter" className={`nav-item ${location.pathname === '/datacenter' ? 'active' : ''}`}>
                        <span className="nav-icon">🏢</span>
                        <span className="nav-text">Data Center</span>
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

            <main className="main-content">
                <header className="content-header">
                    <h1>
                        {location.pathname === '/dashboard' && 'Centreon Service Status Dashboard'}
                        {location.pathname === '/pollers' && 'Pollers Overview'}
                        {location.pathname === '/datacenter' && 'Data Center Overview'}
                        {location.pathname === '/sla' && 'SLA Metrics'}
                        {location.pathname === '/logs' && 'System Audit Log'}
                    </h1>

                    <button className="refresh-btn" onClick={handleGlobalManualRefresh}>
                        Refresh Data
                    </button>
                </header>

                {(location.pathname === '/dashboard' || (location.pathname === '/pollers' && selectedPoller)) && (
                    <div className="stats-grid" style={{ marginBottom: '24px' }}>
                        <div
                            className={`stat-card all ${currentTableType === 'all' ? 'active' : ''}`}
                            onClick={() => {
                                setDashboardGlobalServices([]);
                                setCurrentTableType('all');

                                if (location.pathname === '/dashboard') {
                                    setServicePage(1);
                                    setShowAllStatusesForPoller(true);
                                }
                            }}
                        >
                            <div className="stat-number">{displayCounts.allActiveIssues ?? '-'}</div>
                            <div className="stat-label">All Active Issues</div>
                        </div>

                        <div
                            className={`stat-card critical ${currentTableType === 'critical' ? 'active' : ''}`}
                            onClick={() => {
                                setDashboardGlobalServices([]);
                                setCurrentTableType('critical');

                                if (location.pathname === '/dashboard') {
                                    setServicePage(1);
                                    setShowAllStatusesForPoller(false);
                                }
                            }}
                        >
                            <div className="stat-number">{displayCounts.critical ?? '-'}</div>
                            <div className="stat-label">Critical</div>
                        </div>

                        <div
                            className={`stat-card warning ${currentTableType === 'warning' ? 'active' : ''}`}
                            onClick={() => {
                                setDashboardGlobalServices([]);
                                setCurrentTableType('warning');

                                if (location.pathname === '/dashboard') {
                                    setServicePage(1);
                                    setShowAllStatusesForPoller(false);
                                }
                            }}
                        >
                            <div className="stat-number">{displayCounts.warning ?? '-'}</div>
                            <div className="stat-label">Warning</div>
                        </div>

                        <div
                            className={`stat-card unknown ${currentTableType === 'unknown' ? 'active' : ''}`}
                            onClick={() => {
                                setDashboardGlobalServices([]);
                                setCurrentTableType('unknown');

                                if (location.pathname === '/dashboard') {
                                    setServicePage(1);
                                    setShowAllStatusesForPoller(false);
                                }
                            }}
                        >
                            <div className="stat-number">{displayCounts.unknown ?? '-'}</div>
                            <div className="stat-label">Unknown</div>
                        </div>
                    </div>
                )}

                {location.pathname === '/dashboard' && (
                    <div className="page active">
                        <div className="top-row">
                            <div className="filter-section-compact">
                                <div className="filter-controls-inline">
                                    <div className="filter-input-group-compact">
                                        <label>HOST</label>
                                        <input
                                            type="text"
                                            className="filter-input-compact"
                                            placeholder="Filter host..."
                                            value={filters.host}
                                            onChange={(e) => setFilters(f => ({ ...f, host: e.target.value }))}
                                        />
                                    </div>

                                    <div className="filter-input-group-compact">
                                        <label>SERVICES</label>
                                        <input
                                            type="text"
                                            className="filter-input-compact"
                                            placeholder="Filter service..."
                                            value={filters.service}
                                            onChange={(e) => setFilters(f => ({ ...f, service: e.target.value }))}
                                        />
                                    </div>

                                    <div className="filter-input-group-compact">
                                        <label>POLLERS</label>
                                        <select
                                            className="filter-select-compact"
                                            value={filters.poller}
                                            onChange={(e) => {
                                                setFilters(f => ({ ...f, poller: e.target.value }));
                                                setShowAllStatusesForPoller(false);
                                                setServicePage(1);
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
                                    <div className="filter-input-group-compact">
                                        <label>STATUS</label>
                                        <select
                                            className="filter-select-compact"
                                            value={statusFilter}
                                            onChange={(event) => {
                                                setStatusFilter(event.target.value);
                                                setServicePage(1);
                                            }}
                                        >
                                            <option value="unhandled">Unhandled Problems</option>
                                            <option value="acknowledged">Acknowledged</option>
                                            <option value="all">All Active Problems</option>
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
                                </div>

                                <div className="dashboard-pagination-controls-top">
                                    <span className="service-count">
                                        {dashboardGlobalListMode
                                            ? (
                                                isLoadingDashboardGlobalList
                                                    ? 'Loading...'
                                                    : `${dashboardTableServices.length} of ${dashboardGlobalMeta.total || 0} Targets`
                                            )
                                            : (
                                                isLoadingServices
                                                    ? 'Loading...'
                                                    : `${dashboardTableServices.length} Targets`
                                            )
                                        }
                                        {dashboardGlobalListMode && (
                                            <>
                                                {' '}| Global cache {isRefreshingGlobalSummary ? 'refreshing...' : 'cached'}
                                            </>
                                        )}
                                    </span>

                                    <div className="dashboard-pagination-controls">
                                        <span className="dashboard-pagination-label">Show:</span>
                                        <select
                                            className="dashboard-page-size-select"
                                            value={serviceLimit}
                                            onChange={handlePageSizeChange}
                                            disabled={isLoadingServices || (dashboardGlobalListMode && isLoadingDashboardGlobalList)}
                                        >
                                            <option value="10">10</option>
                                            <option value="20">20</option>
                                            <option value="30">30</option>
                                            <option value="40">40</option>
                                            <option value="50">50</option>
                                            <option value="60">60</option>
                                            <option value="70">70</option>
                                            <option value="80">80</option>
                                            <option value="90">90</option>
                                            <option value="100">100</option>
                                            <option value="999999">All</option>
                                        </select>

                                        <div className="dashboard-pagination-buttons">
                                            <button
                                                className="dashboard-page-btn"
                                                onClick={() => goToPage(servicePage - 1)}
                                                disabled={servicePage <= 1 || totalPages === 0 || isLoadingServices || (dashboardGlobalListMode && isLoadingDashboardGlobalList)}
                                            >
                                                ◀ Prev
                                            </button>

                                            <span className="dashboard-page-info">
                                                Page {totalPages === 0 ? 0 : servicePage} of {totalPages === 0 ? 0 : totalPages}
                                            </span>

                                            <button
                                                className="dashboard-page-btn"
                                                onClick={() => goToPage(servicePage + 1)}
                                                disabled={servicePage >= totalPages || totalPages === 0 || isLoadingServices || (dashboardGlobalListMode && isLoadingDashboardGlobalList)}
                                            >
                                                Next ▶
                                            </button>
                                        </div>
                                    </div>
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
                                            <th>Acknowledge</th>
                                        </tr>
                                    </thead>

                                    <tbody>
                                        {dashboardTableServices.length === 0 ? (
                                            <tr>
                                                <td colSpan="5" className="loading-cell">
                                                    {dashboardGlobalListMode
                                                        ? (
                                                            isLoadingDashboardGlobalList
                                                                ? 'Loading services...'
                                                                : `No ${statusFilter === 'acknowledged' ? 'acknowledged' : statusFilter === 'all' ? '' : 'unhandled '}active issues found matching current criteria.`
                                                        )
                                                        : (
                                                            isLoadingServices
                                                                ? 'Loading services...'
                                                                : `No ${statusFilter === 'acknowledged' ? 'acknowledged' : statusFilter === 'all' ? '' : 'unhandled '}active issues found matching current criteria.`
                                                        )}
                                                </td>
                                            </tr>
                                        ) : (
                                            dashboardTableServices.map((service, idx) => {
                                                const hostName = service.host?.name || service.host?.display_name;
                                                const serviceDescription = service.description || service.display_name;

                                                const hostAddress =
                                                    service.host?.address ||
                                                    service.host?.ip ||
                                                    service.host?.ip_address ||
                                                    service.host?.address_ip ||
                                                    extractIpFromText(service.output);

                                                const ackKey = getAckKey(
                                                    hostName,
                                                    serviceDescription,
                                                    service.host?.id,
                                                    service.id
                                                );

                                                const acknowledged = isServiceAcknowledged(service);
                                                return (
                                                    <tr
                                                        key={`${service.host?.id || service.host?.name || 'host'}-${service.id || service.description || idx}`}
                                                        className={acknowledged
                                                            ? 'service-row-acknowledged'
                                                            : `service-row-${service.statusName?.toLowerCase()}`}
                                                    >
                                                        <td className="host-name">
                                                            {hostName || 'N/A'}
                                                        </td>

                                                        <td className="service-name">
                                                            {serviceDescription || 'N/A'}
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
                                                            {acknowledged ? (
                                                                <button
                                                                    className="ack-badge ack-success-badge"
                                                                    disabled={unackInProgressIds.has(ackKey)}
                                                                    onClick={() => handleUnacknowledge(
                                                                        hostName,
                                                                        serviceDescription,
                                                                        service.host?.id,
                                                                        service.id,
                                                                        hostAddress
                                                                    )}
                                                                    title="Click to remove acknowledgement"
                                                                >
                                                                    {unackInProgressIds.has(ackKey)
                                                                        ? 'REMOVING...'
                                                                        : 'ACKNOWLEDGED'}
                                                                </button>
                                                            ) : (
                                                                <button
                                                                    className="ack-btn ack-action-btn"
                                                                    disabled={ackInProgressIds.has(ackKey)}
                                                                    onClick={() => {
                                                                        setPendingAck({
                                                                            hostName,
                                                                            serviceDescription,
                                                                            hostId: service.host?.id,
                                                                            serviceId: service.id,
                                                                            hostAddress
                                                                        });
                                                                        setAckComment('');
                                                                        setShowAckModal(true);
                                                                    }}
                                                                >
                                                                    {ackInProgressIds.has(ackKey)
                                                                        ? 'ACKING...'
                                                                        : 'ACKNOWLEDGE'}
                                                                </button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

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
                                                placeholder="Filter pollers by name or ID..."
                                                value={pollerSearch}
                                                onChange={(e) => setPollerSearch(e.target.value)}
                                            />
                                        </div>
                                    </div>

                                    <div className="pollers-table-wrapper">
                                        <table className="pollers-table">
                                            <thead>
                                                <tr>
                                                    <th>Poller</th>
                                                    <th>Address</th>
                                                    <th>Server Type</th>
                                                    <th>Total Hosts</th>
                                                    <th>UP</th>
                                                    <th>DOWN</th>
                                                    <th>UNREACHABLE</th>
                                                    <th>PENDING</th>
                                                </tr>
                                            </thead>

                                            <tbody>
                                                {filteredPollers.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="8" className="loading-cell">
                                                            No poller found matching search parameters.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    filteredPollers.map((p, idx) => (
                                                        <tr key={p.poller_id || idx}>
                                                            <td
                                                                className="poller-name"
                                                                style={{ cursor: 'pointer', color: '#58a6ff' }}
                                                                onClick={() => {
                                                                    setSelectedPoller(p.Poller);
                                                                    setSelectedPollerId(p.poller_id);

                                                                    setCurrentTableType('all');
                                                                    setPollerHostPage(1);

                                                                    setPollerHosts([]);
                                                                    setPollerServices([]);
                                                                    setPollerServiceCounts({
                                                                        allActiveIssues: null,
                                                                        critical: null,
                                                                        warning: null,
                                                                        unknown: null
                                                                    });

                                                                }}
                                                            >
                                                                {p.Poller || `Poller ${p.poller_id}`}
                                                            </td>

                                                            <td className="address">{p.Address || 'N/A'}</td>
                                                            <td className="server-type">{p.ServerType || 'N/A'}</td>
                                                            <td className="total-count">{p.Total ?? '-'}</td>
                                                            <td style={{ color: '#3fb950', fontWeight: 'bold' }}>{p.upHosts ?? '-'}</td>
                                                            <td className="critical-count">{p.downHosts ?? '-'}</td>
                                                            <td className="warning-count">{p.unreachableHosts ?? '-'}</td>
                                                            <td style={{ color: '#8b949e', fontWeight: 'bold' }}>{p.pendingHosts ?? '-'}</td>
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
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                                            <button
                                                className="refresh-btn"
                                                onClick={() => {
                                                    setSelectedPoller(null);
                                                    setSelectedPollerId(null);
                                                    setPollerHosts([]);
                                                    setPollerServices([]);
                                                    setPollerServiceCounts({
                                                        allActiveIssues: null,
                                                        critical: null,
                                                        warning: null,
                                                        unknown: null
                                                    });
                                                    setCurrentTableType('all');
                                                }}
                                                style={{ backgroundColor: '#21262d', color: '#c9d1d9' }}
                                            >
                                                ⬅ Back to Pollers List
                                            </button>
                                            <h2>
                                                Poller: <span style={{ color: '#58a6ff' }}>{selectedPoller}</span>
                                            </h2>
                                        </div>

                                        <div className="pollers-pagination-controls">
                                            <div className="pollers-pagination-left">
                                                <span className="pollers-pagination-info">
                                                    Host Page {pollerHostMeta.page || pollerHostPage} of {pollerHostMeta.totalPages || 1}
                                                    {' | '} Hosts: {pollerHostMeta.total || 0}
                                                    {' | '} Active Services: {pollerServices.length}
                                                </span>
                                            </div>
                                            <div className="pollers-pagination-right">
                                                <span className="pollers-pagination-label">Show:</span>
                                                <select
                                                    className="pollers-page-size-select"
                                                    value={pollerHostLimit}
                                                    onChange={handlePollerPageSizeChange}
                                                    disabled={isLoadingPollerHosts || isLoadingPollerServices}
                                                >
                                                    <option value="10">10</option>
                                                    <option value="20">20</option>
                                                    <option value="30">30</option>
                                                    <option value="40">40</option>
                                                    <option value="50">50</option>
                                                    <option value="60">60</option>
                                                    <option value="70">70</option>
                                                    <option value="80">80</option>
                                                    <option value="90">90</option>
                                                    <option value="100">100</option>
                                                    <option value="999999">All</option>
                                                </select>
                                                <div className="pollers-pagination-buttons">
                                                    <button
                                                        className="pollers-page-btn"
                                                        onClick={() => {
                                                            setPollerHostPage(prev => Math.max(prev - 1, 1));
                                                            setCurrentTableType('all');
                                                        }}
                                                        disabled={pollerHostPage <= 1 || isLoadingPollerHosts || isLoadingPollerServices}
                                                    >
                                                        ◀ Prev
                                                    </button>
                                                    <span className="pollers-page-info">
                                                        Page {pollerHostMeta.page || pollerHostPage} of {pollerHostMeta.totalPages || 1}
                                                    </span>
                                                    <button
                                                        className="pollers-page-btn"
                                                        onClick={() => {
                                                            setPollerHostPage(prev => prev + 1);
                                                            setCurrentTableType('all');
                                                        }}
                                                        disabled={pollerHostPage >= (pollerHostMeta.totalPages || 1) || isLoadingPollerHosts || isLoadingPollerServices}
                                                    >
                                                        Next ▶
                                                    </button>
                                                </div>
                                            </div>
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
                                                {isLoadingPollerHosts ? (
                                                    <tr>
                                                        <td colSpan="5" className="loading-cell">
                                                            Loading hosts for {selectedPoller}...
                                                        </td>
                                                    </tr>
                                                ) : isLoadingPollerServices ? (
                                                    <tr>
                                                        <td colSpan="5" className="loading-cell">
                                                            Loading active services for visible hosts...
                                                        </td>
                                                    </tr>
                                                ) : filteredPollerServices.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="5" className="loading-cell">
                                                            No active Critical, Warning, or Unknown services found for this host page.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    filteredPollerServices.map((service, idx) => {
                                                        const hostName = service.host?.name || service.host?.display_name;
                                                        const serviceDescription = service.description || service.display_name;

                                                        const hostAddress =
                                                            service.host?.address ||
                                                            service.host?.ip ||
                                                            service.host?.ip_address ||
                                                            service.host?.address_ip ||
                                                            extractIpFromText(service.output);

                                                        const ackKey = getAckKey(
                                                            hostName,
                                                            serviceDescription,
                                                            service.host?.id,
                                                            service.id
                                                        );

                                                        const acknowledged = isServiceAcknowledged(service);

                                                        return (
                                                            <tr
                                                                key={`${service.host?.id || service.host?.name || 'host'}-${service.id || service.description || idx}`}
                                                                className={
                                                                    acknowledged
                                                                        ? 'service-row-acknowledged'
                                                                        : `service-row-${service.statusName?.toLowerCase()}`
                                                                }
                                                            >
                                                                <td className="host-name">
                                                                    {hostName || 'N/A'}
                                                                </td>

                                                                <td className="service-name">
                                                                    {serviceDescription || 'N/A'}
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
                                                                    {acknowledged ? (
                                                                        <button
                                                                            className="ack-badge ack-success-badge"
                                                                            disabled={unackInProgressIds.has(ackKey)}
                                                                            onClick={() => handleUnacknowledge(
                                                                                hostName,
                                                                                serviceDescription,
                                                                                service.host?.id,
                                                                                service.id,
                                                                                hostAddress
                                                                            )}
                                                                            title="Click to remove acknowledgement"
                                                                        >
                                                                            {unackInProgressIds.has(ackKey) ? 'REMOVING...' : 'ACKNOWLEDGED'}
                                                                        </button>
                                                                    ) : (
                                                                        <button
                                                                            className="ack-btn ack-action-btn"
                                                                            disabled={ackInProgressIds.has(ackKey)}
                                                                            onClick={() => {
                                                                                setPendingAck({
                                                                                    hostName,
                                                                                    serviceDescription,
                                                                                    hostId: service.host?.id,
                                                                                    serviceId: service.id,
                                                                                    hostAddress
                                                                                });
                                                                                setAckComment('');
                                                                                setShowAckModal(true);
                                                                            }}
                                                                        >
                                                                            {ackInProgressIds.has(ackKey) ? 'ACKING...' : 'ACKNOWLEDGE'}
                                                                        </button>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        );
                                                    })
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {location.pathname === '/datacenter' && (
                    <div className="page active">
                        <DataCenterContent
                            groups={dataCenterGroups}
                            counts={dataCenterCounts}
                            meta={dataCenterMeta}
                            loading={dataCenterLoading}
                            error={dataCenterError}
                            search={dataCenterSearch}
                            setSearch={setDataCenterSearch}
                            statusFilter={dataCenterStatusFilter}
                            setStatusFilter={setDataCenterStatusFilter}
                            page={dataCenterPage}
                            setPage={setDataCenterPage}
                            limit={dataCenterLimit}
                            setLimit={setDataCenterLimit}
                            selectedGroup={dataCenterSelectedGroup}
                            setSelectedGroup={setDataCenterSelectedGroup}
                            detailPage={dataCenterDetailPage}
                            setDetailPage={setDataCenterDetailPage}
                            detailLimit={dataCenterDetailLimit}
                            setDetailLimit={setDataCenterDetailLimit}
                            detailFilter={dataCenterDetailFilter}
                            setDetailFilter={setDataCenterDetailFilter}
                            onRefresh={() => fetchDataCenterHostGroups()}
                        />
                    </div>
                )}
                {location.pathname === '/sla' && <Sla />}
                {location.pathname === '/logs' && <Logs />}

                {showAckModal && (
                    <div
                        className="modal-overlay"
                        onClick={() => {
                            setShowAckModal(false);
                            setPendingAck(null);
                            setAckComment('');
                        }}
                    >
                        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                            <h3 className="modal-title">Acknowledge Service</h3>

                            <p className="modal-subtitle">
                                <strong>Host:</strong> {pendingAck?.hostName || 'N/A'}
                                <br />
                                <strong>Service:</strong> {pendingAck?.serviceDescription || 'N/A'}
                                <br />
                                <strong>IP:</strong> {pendingAck?.hostAddress || 'N/A'}
                            </p>

                            <div className="modal-input-group">
                                <label htmlFor="ackComment">Comment optional</label>
                                <textarea
                                    id="ackComment"
                                    className="modal-textarea"
                                    placeholder="Enter a comment for this acknowledgement..."
                                    value={ackComment}
                                    onChange={(e) => setAckComment(e.target.value)}
                                    rows="4"
                                />
                            </div>

                            <div className="modal-actions">
                                <button
                                    className="modal-btn modal-btn-cancel"
                                    onClick={() => {
                                        setShowAckModal(false);
                                        setPendingAck(null);
                                        setAckComment('');
                                    }}
                                >
                                    Cancel
                                </button>

                                <button
                                    className="modal-btn modal-btn-confirm"
                                    onClick={() => {
                                        if (pendingAck) {
                                            const comment =
                                                ackComment.trim() ||
                                                'Acknowledged from GOC Dashboard';

                                            handleAcknowledge(
                                                pendingAck.hostName,
                                                pendingAck.serviceDescription,
                                                pendingAck.hostId,
                                                pendingAck.serviceId,
                                                pendingAck.hostAddress,
                                                comment
                                            );
                                        }

                                        setShowAckModal(false);
                                        setPendingAck(null);
                                        setAckComment('');
                                    }}
                                >
                                    Confirm Acknowledge
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}