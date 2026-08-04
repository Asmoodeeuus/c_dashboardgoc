// backend/src/controllers/centreonController.js
const centreonAxios = require("../config/axiosCentreon");
const db = require("../config/db");

// ============================================================
// IN-MEMORY CACHE
// ============================================================

let pollerHostCountCache = {
    data: {},
    hostsByPoller: {},
    updatedAt: null,
    isRefreshing: false
};

const POLLER_HOST_COUNT_CACHE_TTL_MS = 5 * 60 * 1000;

let dashboardGlobalSummaryCache = {
    counts: {
        allActiveIssues: null,
        critical: null,
        warning: null,
        unknown: null
    },
    services: {
        critical: [],
        warning: [],
        unknown: []
    },
    updatedAt: null,
    isRefreshing: false,
    lastError: null
};

const DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================
// HELPERS
// ============================================================

const getCentreonHeaders = (req) => {
    const authHeader = req.headers.authorization;

    const tokenFromFrontend = authHeader?.startsWith("Bearer ")
        ? authHeader.replace("Bearer ", "")
        : authHeader;

    const activeToken = tokenFromFrontend || process.env.CENTREON_API_TOKEN;

    return {
        "X-AUTH-TOKEN": activeToken,
        "Content-Type": "application/json"
    };
};

const handleCentreonError = (error, res, next) => {
    console.error("Centreon API Error:", {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        code: error.code,
        debug: error.debug
    });

    if (error.response?.status === 401) {
        return res.status(401).json({
            success: false,
            message: "Centreon session invalid or expired."
        });
    }

    if (error.response?.status === 403) {
        return res.status(403).json({
            success: false,
            message: "Centreon refused access. Token may be valid, but user may not have API/realtime permissions."
        });
    }

    return next(error);
};

const getStatusNameFromCode = (statusCode) => {
    switch (Number(statusCode)) {
        case 0:
            return "OK";
        case 1:
            return "WARNING";
        case 2:
            return "CRITICAL";
        case 3:
            return "UNKNOWN";
        default:
            return "UNKNOWN";
    }
};

const isServiceAcknowledged = (service) => {
    const acknowledgement =
        service.acknowledgement ||
        service.acknowledgements ||
        service.ack ||
        null;

    return Boolean(
        service.is_acknowledged === true ||
        service.is_acknowledged === 1 ||
        service.is_acknowledged === "1" ||
        service.is_acknowledged === "true" ||
        service.acknowledged === true ||
        service.acknowledged === 1 ||
        service.acknowledged === "1" ||
        service.acknowledged === "true" ||
        acknowledgement?.is_acknowledged === true ||
        acknowledgement?.is_acknowledged === 1 ||
        acknowledgement?.is_acknowledged === "1" ||
        acknowledgement?.is_acknowledged === "true" ||
        Boolean(acknowledgement?.author) ||
        Boolean(acknowledgement?.comment) ||
        Boolean(acknowledgement?.entry_time)
    );
};

const normalizeService = (service) => {
    const statusCode = Number(
        service.statusCode ??
        service.status?.code ??
        service.state
    );

    const statusName = String(
        service.statusName ||
        service.status?.name ||
        getStatusNameFromCode(statusCode)
    ).toUpperCase();

    const acknowledgement =
        service.acknowledgement ||
        service.acknowledgements ||
        service.ack ||
        null;

    const normalizedService = {
        ...service,
        statusCode,
        statusName,
        acknowledgement,
        poller_name:
            service.poller_name ||
            service.host?.poller_name ||
            (service.host?.poller_id
                ? `Poller ${service.host.poller_id}`
                : "Default Poller")
    };

    const acknowledged = isServiceAcknowledged(normalizedService);

    return {
        ...normalizedService,
        is_acknowledged: acknowledged,
        acknowledged
    };
};

const isActiveIssueService = (service) => {
    return [1, 2, 3].includes(Number(service.statusCode));
};

const isUnhandledActiveService = (service) => {
    return (
        isActiveIssueService(service) &&
        !isServiceAcknowledged(service)
    );
};

const isAcknowledgedActiveService = (service) => {
    return (
        isActiveIssueService(service) &&
        isServiceAcknowledged(service)
    );
};

const getDashboardCachedActiveServices = () => {
    return [
        ...(dashboardGlobalSummaryCache.services.critical || []),
        ...(dashboardGlobalSummaryCache.services.warning || []),
        ...(dashboardGlobalSummaryCache.services.unknown || [])
    ];
};

const normalizeStatusFilter = (value) => {
    const requestedFilter = String(value || "unhandled")
        .trim()
        .toLowerCase();

    const allowedFilters = new Set([
        "unhandled",
        "acknowledged",
        "all"
    ]);

    return allowedFilters.has(requestedFilter)
        ? requestedFilter
        : "unhandled";
};

const filterServicesByHandlingStatus = (services, statusFilter) => {
    const normalizedFilter = normalizeStatusFilter(statusFilter);

    if (normalizedFilter === "acknowledged") {
        return services.filter(isAcknowledgedActiveService);
    }

    if (normalizedFilter === "all") {
        return services.filter(isActiveIssueService);
    }

    return services.filter(isUnhandledActiveService);
};

const buildStatusCounts = (services) => {
    const critical = services.filter(
        (service) => Number(service.statusCode) === 2
    ).length;

    const warning = services.filter(
        (service) => Number(service.statusCode) === 1
    ).length;

    const unknown = services.filter(
        (service) => Number(service.statusCode) === 3
    ).length;

    return {
        allActiveIssues: critical + warning + unknown,
        critical,
        warning,
        unknown
    };
};

const buildServicesEndpoint = ({ page = 1, limit = 100, search = null }) => {
    const params = new URLSearchParams({
        page: String(page),
        limit: String(limit)
    });

    if (search) {
        params.set("search", JSON.stringify(search));
    }

    return `/monitoring/services?${params.toString()}`;
};

const deriveServerType = (server) => {
    const rawType =
        server.server_type ||
        server.type ||
        server.type_name ||
        server.serverType ||
        "";

    if (rawType) return rawType;

    const name = String(
        server.name ||
        server.poller_name ||
        server.server_name ||
        server.instance_name ||
        ""
    ).toLowerCase();

    if (name === "central" || name.includes("central")) return "Central";
    if (name.includes("remote")) return "Remote";
    if (name.includes("poller")) return "Poller";

    return "N/A";
};

const getRequestUserName = (req) => {
    return (
        req.body?.action_by ||
        req.body?.actionBy ||
        req.headers["x-user-name"] ||
        "Dashboard User"
    );
};
    const getOrCreateAuditServerId = async (hostName, hostAddress = null) => {
    const safeHostName = hostName || "Unknown Host";
    const safeHostAddress = hostAddress || safeHostName;

    const [existingRows] = await db.execute(
        `SELECT id, ip_address FROM servers WHERE hostname = ? LIMIT 1`,
        [safeHostName]
    );

    if (existingRows.length > 0) {
        const existingServer = existingRows[0];

        // Optional: if previous fallback was hostname/blank, update it with real IP.
        if (
            hostAddress &&
            (
                !existingServer.ip_address ||
                existingServer.ip_address === safeHostName ||
                existingServer.ip_address === "0.0.0.0"
            )
        ) {
            await db.execute(
                `UPDATE servers SET ip_address = ? WHERE id = ?`,
                [hostAddress, existingServer.id]
            );
        }

        return existingServer.id;
    }

    const [insertResult] = await db.execute(
        `
        INSERT INTO servers (hostname, ip_address)
        VALUES (?, ?)
        `,
        [safeHostName, safeHostAddress]
    );

    return insertResult.insertId;
};

const writeAuditLog = async ({
    host,
    hostAddress,
    service,
    logType,
    oldStatus,
    newStatus,
    actionBy,
    message
}) => {
const serverId = await getOrCreateAuditServerId(host, hostAddress);
    const query = `
        INSERT INTO server_activity_log
        (server_id, incident_id, service_name, log_type, old_status, new_status, action_by, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [insertResult] = await db.execute(query, [
        serverId,
        null,
        service || null,
        logType,
        oldStatus || null,
        newStatus || null,
        actionBy || "Dashboard User",
        message || null
    ]);

    return {
        serverId,
        auditLogId: insertResult.insertId
    };
};

// ============================================================
// ACK / UNACK CACHE HELPERS
// ============================================================

const recalculateDashboardGlobalCounts = () => {
    const allActiveServices = getDashboardCachedActiveServices();
    const unhandledServices = filterServicesByHandlingStatus(
        allActiveServices,
        "unhandled"
    );
    const updatedCounts = buildStatusCounts(unhandledServices);

    dashboardGlobalSummaryCache = {
        ...dashboardGlobalSummaryCache,
        counts: updatedCounts
    };

    return updatedCounts;
};

const markDashboardCachedServiceAsAcknowledged = ({
    hostId,
    serviceId,
    hostName,
    serviceDescription,
    comment,
    actionBy
}) => {
    let patchedCount = 0;

    const targetHostName = String(
        hostName || ""
    ).trim().toLowerCase();

    const targetServiceDescription = String(
        serviceDescription || ""
    ).trim().toLowerCase();

    const patchService = (service) => {
        const currentServiceId =
            service.id ??
            service.service_id ??
            service.serviceId;

        const currentHostId =
            service.host?.id ??
            service.host?.host_id ??
            service.host_id;

        const currentHostName = String(
            service.host?.name ||
            service.host?.display_name ||
            service.host_name ||
            ""
        ).trim().toLowerCase();

        const currentServiceDescription = String(
            service.description ||
            service.display_name ||
            service.service_name ||
            ""
        ).trim().toLowerCase();

        let isMatch = false;

        if (
            serviceId !== undefined &&
            serviceId !== null
        ) {
            isMatch =
                String(currentServiceId) ===
                String(serviceId);
        } else if (
            hostId !== undefined &&
            hostId !== null
        ) {
            isMatch =
                String(currentHostId) === String(hostId) &&
                currentServiceDescription ===
                    targetServiceDescription;
        } else {
            isMatch =
                currentHostName === targetHostName &&
                currentServiceDescription ===
                    targetServiceDescription;
        }

        if (!isMatch) {
            return service;
        }

        patchedCount += 1;

        return {
            ...service,
            is_acknowledged: true,
            acknowledged: true,
            acknowledgement: {
                ...(
                    typeof service.acknowledgement === "object" &&
                    service.acknowledgement !== null &&
                    !Array.isArray(service.acknowledgement)
                        ? service.acknowledgement
                        : {}
                ),
                is_acknowledged: true,
                author: actionBy || "Dashboard User",
                comment:
                    comment ||
                    "Acknowledged from GOC Dashboard",
                entry_time: new Date().toISOString()
            }
        };
    };

    dashboardGlobalSummaryCache = {
        ...dashboardGlobalSummaryCache,
        services: {
            critical: (
                dashboardGlobalSummaryCache.services.critical || []
            ).map(patchService),

            warning: (
                dashboardGlobalSummaryCache.services.warning || []
            ).map(patchService),

            unknown: (
                dashboardGlobalSummaryCache.services.unknown || []
            ).map(patchService)
        }
    };

    const updatedCounts =
        recalculateDashboardGlobalCounts();

    console.log("Dashboard ACK cache patch result:", {
        patchedCount,
        hostId,
        serviceId,
        hostName,
        serviceDescription,
        updatedCounts
    });

    return patchedCount;
};

const markDashboardCachedServiceAsUnacknowledged = ({
    hostId,
    serviceId,
    hostName,
    serviceDescription
}) => {
    let patchedCount = 0;

    const targetHostName = String(
        hostName || ""
    ).trim().toLowerCase();

    const targetServiceDescription = String(
        serviceDescription || ""
    ).trim().toLowerCase();

    const patchService = (service) => {
        const currentServiceId =
            service.id ??
            service.service_id ??
            service.serviceId;

        const currentHostId =
            service.host?.id ??
            service.host?.host_id ??
            service.host_id;

        const currentHostName = String(
            service.host?.name ||
            service.host?.display_name ||
            service.host_name ||
            ""
        ).trim().toLowerCase();

        const currentServiceDescription = String(
            service.description ||
            service.display_name ||
            service.service_name ||
            ""
        ).trim().toLowerCase();

        let isMatch = false;

        if (
            serviceId !== undefined &&
            serviceId !== null
        ) {
            isMatch =
                String(currentServiceId) ===
                String(serviceId);
        } else if (
            hostId !== undefined &&
            hostId !== null
        ) {
            isMatch =
                String(currentHostId) === String(hostId) &&
                currentServiceDescription ===
                    targetServiceDescription;
        } else {
            isMatch =
                currentHostName === targetHostName &&
                currentServiceDescription ===
                    targetServiceDescription;
        }

        if (!isMatch) {
            return service;
        }

        patchedCount += 1;

        return {
            ...service,
            is_acknowledged: false,
            acknowledged: false,
            acknowledgement: null
        };
    };

    dashboardGlobalSummaryCache = {
        ...dashboardGlobalSummaryCache,
        services: {
            critical: (
                dashboardGlobalSummaryCache.services.critical || []
            ).map(patchService),

            warning: (
                dashboardGlobalSummaryCache.services.warning || []
            ).map(patchService),

            unknown: (
                dashboardGlobalSummaryCache.services.unknown || []
            ).map(patchService)
        }
    };

    const updatedCounts =
        recalculateDashboardGlobalCounts();

    console.log("Dashboard UNACK cache patch result:", {
        patchedCount,
        hostId,
        serviceId,
        hostName,
        serviceDescription,
        updatedCounts
    });

    return patchedCount;
};

const sendCentreonUnacknowledgeRequest = async (req, payload) => {
    const resource = payload.resources?.[0];

    const hostId =
        resource?.parent?.id ??
        resource?.host_id ??
        resource?.hostId;

    const serviceId =
        resource?.id ??
        resource?.service_id ??
        resource?.serviceId;

    if (!hostId || !serviceId) {
        const error = new Error("Missing hostId or serviceId for Centreon unacknowledge.");
        error.debug = { payload, hostId, serviceId };
        throw error;
    }

    const attempts = [
        {
            label: "DELETE /monitoring/hosts/{hostId}/services/{serviceId}/acknowledgements",
            method: "delete",
            endpoint: `/monitoring/hosts/${hostId}/services/${serviceId}/acknowledgements`,
            data: null
        },
        {
            label: "DELETE /monitoring/resources/acknowledgements",
            method: "delete",
            endpoint: "/monitoring/resources/acknowledgements",
            data: {
                disacknowledgement: {
                    with_services: false
                },
                resources: payload.resources
            }
        }
    ];

    const errors = [];

    for (const attempt of attempts) {
        try {
            console.log(`Centreon unacknowledge attempt [${attempt.label}]:`, {
                endpoint: attempt.endpoint,
                data: attempt.data
            });

            return await centreonAxios.delete(attempt.endpoint, {
                headers: getCentreonHeaders(req),
                data: attempt.data || undefined
            });

        } catch (error) {
            errors.push({
                label: attempt.label,
                endpoint: attempt.endpoint,
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            });

            console.warn(`Centreon unacknowledge failed [${attempt.label}]`, {
                endpoint: attempt.endpoint,
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            });
        }
    }

    const finalError = new Error("All Centreon unacknowledge attempts failed.");
    finalError.debug = errors;
    throw finalError;
};

// ============================================================
// MONITORING SERVER / CACHE HELPERS
// ============================================================

const getMonitoringServerMap = async (req) => {
    try {
        const serverMap = {};
        const limit = 1000;
        let page = 1;
        let counted = 0;
        let totalFromCentreon = 0;

        while (true) {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit)
            });

            const endpoint = `/configuration/monitoring-servers?${params.toString()}`;

            console.log("Centreon getMonitoringServerMap URL:", endpoint);

            const response = await centreonAxios.get(endpoint, {
                headers: getCentreonHeaders(req)
            });

            const servers =
                response.data?.result ||
                response.data?.data?.result ||
                response.data?.items ||
                response.data?.data ||
                [];

            totalFromCentreon =
                response.data?.meta?.total ||
                response.data?.data?.meta?.total ||
                servers.length;

            servers.forEach((server) => {
                const id =
                    server.id ??
                    server.poller_id ??
                    server.monitoring_server_id ??
                    server.server_id;

                const name =
                    server.name ??
                    server.poller_name ??
                    server.server_name ??
                    server.instance_name;

                if (id !== undefined && id !== null) {
                    serverMap[String(id)] = {
                        id,
                        name: name || `Poller ${id}`,
                        address:
                            server.address ||
                            server.address_ip ||
                            server.ip ||
                            server.ip_address ||
                            "",
                        server_type: deriveServerType(server)
                    };
                }
            });

            counted += servers.length;

            if (counted >= totalFromCentreon || servers.length === 0) break;
            page += 1;
        }

        console.log("Monitoring server map:", serverMap);
        return serverMap;

    } catch (error) {
        console.warn("Unable to fetch Centreon monitoring servers. Falling back to Poller ID names.", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        });

        return {};
    }
};

const refreshPollerHostCountCache = async (req, monitoringServerMap) => {
    if (pollerHostCountCache.isRefreshing) return;

    pollerHostCountCache.isRefreshing = true;

    try {
        const countMap = {};
        const hostsByPoller = {};
        const limit = 1000;
        let page = 1;
        let counted = 0;
        let totalFromCentreon = 0;

        Object.values(monitoringServerMap).forEach((server) => {
            const pollerId = String(server.id);

            countMap[pollerId] = {
                totalHosts: 0,
                upHosts: 0,
                downHosts: 0,
                unreachableHosts: 0,
                pendingHosts: 0
            };

            hostsByPoller[pollerId] = [];
        });

        while (true) {
            const endpoint = `/monitoring/hosts?page=${page}&limit=${limit}`;

            console.log("Centreon background poller host count URL:", endpoint);

            const response = await centreonAxios.get(endpoint, {
                headers: getCentreonHeaders(req)
            });

            const hosts = response.data?.result || [];

            totalFromCentreon =
                response.data?.meta?.total ||
                hosts.length;

            hosts.forEach((host) => {
                const pollerId = String(host.poller_id ?? "unknown");
                const mappedServer = monitoringServerMap[pollerId];

                if (!countMap[pollerId]) {
                    countMap[pollerId] = {
                        totalHosts: 0,
                        upHosts: 0,
                        downHosts: 0,
                        unreachableHosts: 0,
                        pendingHosts: 0
                    };
                }

                if (!hostsByPoller[pollerId]) {
                    hostsByPoller[pollerId] = [];
                }

                const normalizedHost = {
                    ...host,
                    poller_name:
                        host.poller_name ||
                        mappedServer?.name ||
                        (host.poller_id ? `Poller ${host.poller_id}` : "Default Poller"),
                    poller_address: mappedServer?.address || "",
                    poller_server_type: mappedServer?.server_type || ""
                };

                hostsByPoller[pollerId].push(normalizedHost);

                countMap[pollerId].totalHosts += 1;

                const state = Number(host.state);

                if (state === 0) countMap[pollerId].upHosts += 1;
                else if (state === 1) countMap[pollerId].downHosts += 1;
                else if (state === 2) countMap[pollerId].unreachableHosts += 1;
                else if (state === 3) countMap[pollerId].pendingHosts += 1;
            });

            counted += hosts.length;

            if (counted >= totalFromCentreon || hosts.length === 0) break;
            page += 1;
        }

        pollerHostCountCache = {
            data: countMap,
            hostsByPoller,
            updatedAt: Date.now(),
            isRefreshing: false
        };

        console.log("Poller host count/cache refreshed:", {
            totalPollers: Object.keys(countMap).length,
            totalHosts: counted
        });

    } catch (error) {
        console.error("Failed refreshing poller host count cache:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        });

        pollerHostCountCache.isRefreshing = false;
    }
};

const refreshDashboardGlobalSummaryCache = async (req) => {
    if (dashboardGlobalSummaryCache.isRefreshing) {
        return;
    }

    dashboardGlobalSummaryCache.isRefreshing = true;

    try {
        const limit = 1000;
        let page = 1;
        let counted = 0;
        let totalFromCentreon = 0;

        const criticalServices = [];
        const warningServices = [];
        const unknownServices = [];

        while (true) {
            const endpoint = buildServicesEndpoint({ page, limit });

            console.log(
                "Centreon dashboard global summary cache URL:",
                endpoint
            );

            const response = await centreonAxios.get(endpoint, {
                headers: getCentreonHeaders(req)
            });

            const services = response.data?.result || [];
            const normalizedServices = services.map(normalizeService);

            normalizedServices.forEach((service) => {
                if (!isActiveIssueService(service)) {
                    return;
                }

                if (service.statusCode === 2) {
                    criticalServices.push(service);
                } else if (service.statusCode === 1) {
                    warningServices.push(service);
                } else if (service.statusCode === 3) {
                    unknownServices.push(service);
                }
            });

            totalFromCentreon =
                Number(response.data?.meta?.total) ||
                services.length;

            counted += services.length;

            if (counted >= totalFromCentreon || services.length === 0) {
                break;
            }

            page += 1;
        }

        const allActiveServices = [
            ...criticalServices,
            ...warningServices,
            ...unknownServices
        ];

        const unhandledServices = filterServicesByHandlingStatus(
            allActiveServices,
            "unhandled"
        );

        const acknowledgedServices = filterServicesByHandlingStatus(
            allActiveServices,
            "acknowledged"
        );

        const unhandledCounts = buildStatusCounts(unhandledServices);

        dashboardGlobalSummaryCache = {
            counts: unhandledCounts,
            services: {
                critical: criticalServices,
                warning: warningServices,
                unknown: unknownServices
            },
            updatedAt: Date.now(),
            isRefreshing: false,
            lastError: null
        };

        console.log("Dashboard global summary cache refreshed:", {
            totalServicesScanned: counted,
            totalActiveServicesCached: allActiveServices.length,
            totalUnhandledServices: unhandledServices.length,
            totalAcknowledgedServices: acknowledgedServices.length,
            cachedByStatus: {
                critical: criticalServices.length,
                warning: warningServices.length,
                unknown: unknownServices.length
            },
            unhandledCounts
        });
    } catch (error) {
        console.error("Failed refreshing dashboard global summary cache:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        });

        dashboardGlobalSummaryCache = {
            ...dashboardGlobalSummaryCache,
            isRefreshing: false,
            lastError: {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            }
        };
    }
};

// ============================================================
// HOST ENDPOINTS
// ============================================================

const getAllHosts = async (req, res, next) => {
    try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 100;

        const endpoint = `/monitoring/hosts?page=${page}&limit=${limit}`;

        console.log("Centreon getAllHosts URL:", endpoint);

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        return res.json({
            success: true,
            count: response.data?.result?.length || 0,
            data: response.data,
            meta: response.data?.meta || {
                page,
                limit,
                total: response.data?.result?.length || 0
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const getHostById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const endpoint = `/monitoring/hosts/${id}`;

        console.log("Centreon getHostById URL:", endpoint);

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        return res.json({
            success: true,
            data: response.data
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const getHostStatus = async (req, res, next) => {
    try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 100;

        const endpoint = `/monitoring/hosts?page=${page}&limit=${limit}`;

        console.log("Centreon getHostStatus URL:", endpoint);

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        return res.json({
            success: true,
            data: response.data
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// ============================================================
// POLLER ENDPOINTS
// ============================================================

const getAllPollers = async (req, res, next) => {
    try {
        const monitoringServerMap = await getMonitoringServerMap(req);
        const now = Date.now();

        const hasFreshCache =
            pollerHostCountCache.updatedAt &&
            now - pollerHostCountCache.updatedAt < POLLER_HOST_COUNT_CACHE_TTL_MS;

        if (!hasFreshCache && !pollerHostCountCache.isRefreshing) {
            refreshPollerHostCountCache(req, monitoringServerMap);
        }

        const pollers = Object.values(monitoringServerMap)
            .map((server) => {
                const pollerId = String(server.id);
                const cachedCounts = pollerHostCountCache.data[pollerId];

                return {
                    poller_id: server.id,
                    poller_name: server.name || `Poller ${server.id}`,
                    address: server.address || "",
                    server_type: server.server_type || "",
                    totalHosts: cachedCounts?.totalHosts ?? null,
                    upHosts: cachedCounts?.upHosts ?? null,
                    downHosts: cachedCounts?.downHosts ?? null,
                    unreachableHosts: cachedCounts?.unreachableHosts ?? null,
                    pendingHosts: cachedCounts?.pendingHosts ?? null
                };
            })
            .sort((a, b) => {
                const nameA = String(a.poller_name || "").toLowerCase();
                const nameB = String(b.poller_name || "").toLowerCase();
                return nameA.localeCompare(nameB);
            });

        return res.json({
            success: true,
            count: pollers.length,
            data: {
                result: pollers
            },
            meta: {
                totalPollers: pollers.length,
                hostCountLoaded: Boolean(hasFreshCache),
                hostCountRefreshing: pollerHostCountCache.isRefreshing,
                hostCountUpdatedAt: pollerHostCountCache.updatedAt
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const getPollerHosts = async (req, res, next) => {
    try {
        const { pollerId } = req.params;
        const monitoringServerMap = await getMonitoringServerMap(req);
        const mappedServer = monitoringServerMap[String(pollerId)];

        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 20;

        const now = Date.now();

        const hasAnyCache =
            pollerHostCountCache.updatedAt &&
            pollerHostCountCache.hostsByPoller;

        const hasFreshCache =
            pollerHostCountCache.updatedAt &&
            now - pollerHostCountCache.updatedAt < POLLER_HOST_COUNT_CACHE_TTL_MS;

        if (!hasFreshCache && !pollerHostCountCache.isRefreshing) {
            refreshPollerHostCountCache(req, monitoringServerMap);
        }

        const allHostsForPoller =
            pollerHostCountCache.hostsByPoller?.[String(pollerId)] || [];

        if (!hasAnyCache) {
            return res.json({
                success: true,
                poller_id: pollerId,
                poller_name: mappedServer?.name || `Poller ${pollerId}`,
                poller_address: mappedServer?.address || "",
                poller_server_type: mappedServer?.server_type || "",
                count: 0,
                data: { result: [] },
                meta: {
                    page,
                    limit,
                    total: 0,
                    totalPages: 1,
                    hostCacheLoaded: false,
                    hostCacheRefreshing: pollerHostCountCache.isRefreshing
                }
            });
        }

        const startIndex = (page - 1) * limit;
        const pagedHosts = allHostsForPoller.slice(startIndex, startIndex + limit);

        return res.json({
            success: true,
            poller_id: pollerId,
            poller_name: mappedServer?.name || `Poller ${pollerId}`,
            poller_address: mappedServer?.address || "",
            poller_server_type: mappedServer?.server_type || "",
            count: pagedHosts.length,
            data: {
                result: pagedHosts
            },
            meta: {
                page,
                limit,
                total: allHostsForPoller.length,
                totalPages: Math.max(1, Math.ceil(allHostsForPoller.length / limit)),
                hostCacheLoaded: true,
                hostCacheFresh: Boolean(hasFreshCache),
                hostCacheRefreshing: pollerHostCountCache.isRefreshing,
                hostCacheUpdatedAt: pollerHostCountCache.updatedAt
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const getPollerServiceSummary = async (req, res, next) => {
    try {
        const { pollerId } = req.params;
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 100;

        const monitoringServerMap = await getMonitoringServerMap(req);
        const mappedServer = monitoringServerMap[String(pollerId)];

        return res.json({
            success: true,
            poller_id: pollerId,
            poller_name: mappedServer?.name || `Poller ${pollerId}`,
            poller_address: mappedServer?.address || "",
            poller_server_type: mappedServer?.server_type || "",
            mode: "fast-no-scan",
            counts: {
                allServices: null,
                critical: null,
                warning: null,
                unknown: null
            },
            services: {
                critical: [],
                warning: [],
                unknown: []
            },
            data: {
                result: []
            },
            meta: {
                page,
                limit,
                total: 0,
                totalPages: 1
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// ============================================================
// SERVICE ENDPOINTS
// ============================================================

const getAllServices = async (req, res, next) => {
    try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 100;

        const endpoint = buildServicesEndpoint({ page, limit });

        console.log("Centreon getAllServices URL:", endpoint);

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        const services = response.data?.result || [];
        const normalizedServices = services.map(normalizeService);

        return res.json({
            success: true,
            count: normalizedServices.length,
            data: {
                ...response.data,
                result: normalizedServices
            },
            meta: response.data?.meta || {
                page,
                limit,
                total: normalizedServices.length
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const searchServicesGlobally = async (req, res, next) => {
    try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 100;

        const q = String(req.query.q || "").trim();
        const host = String(req.query.host || "").trim();
        const service = String(req.query.service || "").trim();

        if (!q && !host && !service) {
            return res.status(400).json({
                success: false,
                message: "Please provide q, host, or service query parameter."
            });
        }

        const mergedMap = new Map();
        const attemptResults = [];

        const runSearchAttempt = async (label, searchObject) => {
            try {
                const endpoint = buildServicesEndpoint({
                    page,
                    limit,
                    search: searchObject
                });

                console.log(`Centreon global service search [${label}]:`, endpoint);

                const response = await centreonAxios.get(endpoint, {
                    headers: getCentreonHeaders(req)
                });

                const normalizedServices = (response.data?.result || []).map(normalizeService);

                normalizedServices.forEach((serviceItem) => {
                    const key = serviceItem.id || `${serviceItem.host?.name}-${serviceItem.description}`;
                    mergedMap.set(key, serviceItem);
                });

                attemptResults.push({
                    label,
                    success: true,
                    count: normalizedServices.length,
                    total: response.data?.meta?.total ?? normalizedServices.length
                });

            } catch (error) {
                console.warn(`Centreon search attempt failed [${label}]`, {
                    status: error.response?.status,
                    data: error.response?.data,
                    message: error.message
                });

                attemptResults.push({
                    label,
                    success: false,
                    status: error.response?.status,
                    data: error.response?.data,
                    message: error.message
                });
            }
        };

        if (q || host) {
            const hostTerm = host || q;

            await runSearchAttempt("host.name", {
                "host.name": hostTerm
            });

            await runSearchAttempt("host.alias", {
                "host.alias": hostTerm
            });
        }

        if (q || service) {
            const serviceTerm = service || q;

            await runSearchAttempt("service.description", {
                "service.description": serviceTerm
            });
        }

        let results = Array.from(mergedMap.values());

        if (host) {
            const hostLower = host.toLowerCase();

            results = results.filter(item => {
                const hostName = item.host?.name?.toLowerCase() || "";
                const hostAlias = item.host?.alias?.toLowerCase() || "";
                const hostDisplayName = item.host?.display_name?.toLowerCase() || "";

                return (
                    hostName.includes(hostLower) ||
                    hostAlias.includes(hostLower) ||
                    hostDisplayName.includes(hostLower)
                );
            });
        }

        if (service) {
            const serviceLower = service.toLowerCase();

            results = results.filter(item => {
                const description = item.description?.toLowerCase() || "";
                const displayName = item.display_name?.toLowerCase() || "";

                return (
                    description.includes(serviceLower) ||
                    displayName.includes(serviceLower)
                );
            });
        }

        const criticalServices = results.filter(item => item.statusCode === 2);
        const warningServices = results.filter(item => item.statusCode === 1);
        const unknownServices = results.filter(item => item.statusCode === 3);

        return res.json({
            success: true,
            query: {
                q,
                host,
                service,
                page,
                limit
            },
            count: results.length,
            counts: {
                allActiveIssues: criticalServices.length + warningServices.length + unknownServices.length,
                critical: criticalServices.length,
                warning: warningServices.length,
                unknown: unknownServices.length
            },
            data: {
                result: results
            },
            services: {
                critical: criticalServices,
                warning: warningServices,
                unknown: unknownServices
            },
            debug: {
                attempts: attemptResults
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const getServicesByHost = async (req, res, next) => {
    try {
        const { hostId } = req.params;

        const endpoint = buildServicesEndpoint({
            page: 1,
            limit: 100,
            search: {
                "host.id": Number(hostId)
            }
        });

        console.log("Centreon getServicesByHost URL:", endpoint);

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        const normalizedServices = (response.data?.result || []).map(normalizeService);

        return res.json({
            success: true,
            count: normalizedServices.length,
            data: {
                ...response.data,
                result: normalizedServices
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// ============================================================
// SUMMARY ENDPOINTS
// ============================================================

const getServiceStatusSummary = async (req, res, next) => {
    try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 100;

        const endpoint = buildServicesEndpoint({ page, limit });

        console.log("Centreon getServiceStatusSummary URL:", endpoint);

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        const normalizedServices = (response.data?.result || []).map(normalizeService);

        const criticalServices = normalizedServices.filter(service => service.statusCode === 2);
        const warningServices = normalizedServices.filter(service => service.statusCode === 1);
        const unknownServices = normalizedServices.filter(service => service.statusCode === 3);
        const okServices = normalizedServices.filter(service => service.statusCode === 0);

        const allProblemServices =
            criticalServices.length +
            warningServices.length +
            unknownServices.length;

        return res.json({
            success: true,
            counts: {
                ok: okServices.length,
                critical: criticalServices.length,
                warning: warningServices.length,
                unknown: unknownServices.length,
                allServices: allProblemServices,
                totalPageServices: normalizedServices.length
            },
            services: {
                critical: criticalServices,
                warning: warningServices,
                unknown: unknownServices
            },
            data: {
                ...response.data,
                result: normalizedServices
            },
            meta: response.data?.meta || {
                page,
                limit,
                total: normalizedServices.length
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const getGlobalServiceStatusSummary = async (req, res, next) => {
    try {
        const now = Date.now();

        const hasCachedCounts =
            dashboardGlobalSummaryCache.updatedAt &&
            dashboardGlobalSummaryCache.counts.allActiveIssues !== null;

        const hasFreshCache =
            dashboardGlobalSummaryCache.updatedAt &&
            now - dashboardGlobalSummaryCache.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;

        if (!hasFreshCache && !dashboardGlobalSummaryCache.isRefreshing) {
            refreshDashboardGlobalSummaryCache(req);
        }

        return res.json({
            success: true,
            cached: Boolean(hasCachedCounts),
            refreshing: dashboardGlobalSummaryCache.isRefreshing,
            counts: dashboardGlobalSummaryCache.counts,
            services: dashboardGlobalSummaryCache.services,
            meta: {
                cacheLoaded: Boolean(hasCachedCounts),
                cacheFresh: Boolean(hasFreshCache),
                cacheRefreshing: dashboardGlobalSummaryCache.isRefreshing,
                cacheUpdatedAt: dashboardGlobalSummaryCache.updatedAt,
                cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS,
                lastError: dashboardGlobalSummaryCache.lastError
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

const getGlobalServiceStatusSummaryList = async (req, res, next) => {
    try {
        const requestedType = String(req.query.type || "all")
            .trim()
            .toLowerCase();

        const allowedTypes = new Set([
            "all",
            "critical",
            "warning",
            "unknown"
        ]);

        const type = allowedTypes.has(requestedType)
            ? requestedType
            : "all";

        const statusFilter = normalizeStatusFilter(
            req.query.statusFilter
        );

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(
            999999,
            Math.max(1, Number(req.query.limit) || 100)
        );

        const hostSearch = String(req.query.host || "")
            .trim()
            .toLowerCase();

        const serviceSearch = String(req.query.service || "")
            .trim()
            .toLowerCase();

        const qSearch = String(req.query.q || "")
            .trim()
            .toLowerCase();

        const now = Date.now();

        const hasCachedCounts = Boolean(
            dashboardGlobalSummaryCache.updatedAt &&
            dashboardGlobalSummaryCache.counts.allActiveIssues !== null
        );

        const hasFreshCache = Boolean(
            dashboardGlobalSummaryCache.updatedAt &&
            now - dashboardGlobalSummaryCache.updatedAt <
                DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
        );

        if (!hasFreshCache && !dashboardGlobalSummaryCache.isRefreshing) {
            refreshDashboardGlobalSummaryCache(req);
        }

        if (!hasCachedCounts) {
            return res.json({
                success: true,
                cached: false,
                refreshing: dashboardGlobalSummaryCache.isRefreshing,
                type,
                statusFilter,
                query: {
                    host: hostSearch,
                    service: serviceSearch,
                    q: qSearch
                },
                counts: {
                    allActiveIssues: 0,
                    critical: 0,
                    warning: 0,
                    unknown: 0
                },
                filteredCounts: {
                    allActiveIssues: 0,
                    critical: 0,
                    warning: 0,
                    unknown: 0
                },
                data: { result: [] },
                meta: {
                    page,
                    limit,
                    total: 0,
                    totalPages: 1,
                    filteredTotal: 0,
                    cacheLoaded: false,
                    cacheFresh: false,
                    cacheRefreshing: dashboardGlobalSummaryCache.isRefreshing,
                    cacheUpdatedAt: dashboardGlobalSummaryCache.updatedAt,
                    cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                }
            });
        }

        const allActiveServices = getDashboardCachedActiveServices();
        const handlingFilteredServices = filterServicesByHandlingStatus(
            allActiveServices,
            statusFilter
        );

        const counts = buildStatusCounts(handlingFilteredServices);
        let searchedServices = handlingFilteredServices;

        if (hostSearch || serviceSearch || qSearch) {
            searchedServices = handlingFilteredServices.filter((service) => {
                const hostName = String(service.host?.name || "").toLowerCase();
                const hostDisplayName = String(
                    service.host?.display_name || ""
                ).toLowerCase();
                const hostAlias = String(service.host?.alias || "").toLowerCase();
                const serviceDescription = String(
                    service.description || ""
                ).toLowerCase();
                const serviceDisplayName = String(
                    service.display_name || ""
                ).toLowerCase();
                const output = String(service.output || "").toLowerCase();

                const matchesHost =
                    !hostSearch ||
                    hostName.includes(hostSearch) ||
                    hostDisplayName.includes(hostSearch) ||
                    hostAlias.includes(hostSearch);

                const matchesService =
                    !serviceSearch ||
                    serviceDescription.includes(serviceSearch) ||
                    serviceDisplayName.includes(serviceSearch) ||
                    output.includes(serviceSearch);

                const matchesQ =
                    !qSearch ||
                    hostName.includes(qSearch) ||
                    hostDisplayName.includes(qSearch) ||
                    hostAlias.includes(qSearch) ||
                    serviceDescription.includes(qSearch) ||
                    serviceDisplayName.includes(qSearch) ||
                    output.includes(qSearch);

                return matchesHost && matchesService && matchesQ;
            });
        }

        const filteredCounts = buildStatusCounts(searchedServices);

        let selectedServices;

        if (type === "critical") {
            selectedServices = searchedServices.filter(
                (service) => Number(service.statusCode) === 2
            );
        } else if (type === "warning") {
            selectedServices = searchedServices.filter(
                (service) => Number(service.statusCode) === 1
            );
        } else if (type === "unknown") {
            selectedServices = searchedServices.filter(
                (service) => Number(service.statusCode) === 3
            );
        } else {
            selectedServices = searchedServices;
        }

        const startIndex = (page - 1) * limit;
        const pagedServices = selectedServices.slice(
            startIndex,
            startIndex + limit
        );

        const unhandledTotal = allActiveServices.filter(
            isUnhandledActiveService
        ).length;

        const acknowledgedTotal = allActiveServices.filter(
            isAcknowledgedActiveService
        ).length;

        return res.json({
            success: true,
            cached: true,
            refreshing: dashboardGlobalSummaryCache.isRefreshing,
            type,
            statusFilter,
            query: {
                host: hostSearch,
                service: serviceSearch,
                q: qSearch
            },
            counts,
            filteredCounts,
            data: { result: pagedServices },
            meta: {
                page,
                limit,
                total: selectedServices.length,
                totalPages: Math.max(
                    1,
                    Math.ceil(selectedServices.length / limit)
                ),
                filteredTotal: searchedServices.length,
                cacheLoaded: true,
                cacheFresh: hasFreshCache,
                cacheRefreshing: dashboardGlobalSummaryCache.isRefreshing,
                cacheUpdatedAt: dashboardGlobalSummaryCache.updatedAt,
                cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS,
                totalActiveServicesCached: allActiveServices.length,
                totalUnhandledServices: unhandledTotal,
                totalAcknowledgedServices: acknowledgedTotal
            }
        });
    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// ============================================================
// DATA CENTER - HOST GROUPS WITH ISSUE COUNTS
// ============================================================

const getDataCenterHostGroups = async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(
            1000,
            Math.max(1, Number(req.query.limit) || 20)
        );

        const statusFilter = normalizeStatusFilter(
            req.query.statusFilter
        );

        const search = String(req.query.search || "")
            .trim()
            .toLowerCase();

        const includeHosts = ![
            "false",
            "0",
            "no"
        ].includes(
            String(req.query.includeHosts ?? "true")
                .trim()
                .toLowerCase()
        );

        const now = Date.now();
        const cacheLoaded = Boolean(dashboardGlobalSummaryCache.updatedAt);
        const cacheFresh = Boolean(
            dashboardGlobalSummaryCache.updatedAt &&
            now - dashboardGlobalSummaryCache.updatedAt <
                DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
        );

        if (!cacheFresh && !dashboardGlobalSummaryCache.isRefreshing) {
            refreshDashboardGlobalSummaryCache(req);
        }

        if (!cacheLoaded) {
            return res.json({
                success: true,
                cached: false,
                refreshing: dashboardGlobalSummaryCache.isRefreshing,
                statusFilter,
                query: { search, includeHosts },
                counts: {
                    hostGroups: 0,
                    uniqueHosts: 0,
                    hostsWithIssues: 0,
                    allActiveIssues: 0,
                    critical: 0,
                    warning: 0,
                    unknown: 0
                },
                data: { result: [] },
                meta: {
                    page,
                    limit,
                    total: 0,
                    totalPages: 1,
                    cacheLoaded: false,
                    cacheFresh: false,
                    cacheRefreshing: dashboardGlobalSummaryCache.isRefreshing,
                    cacheUpdatedAt: dashboardGlobalSummaryCache.updatedAt,
                    cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                }
            });
        }

        const allActiveServices = getDashboardCachedActiveServices();
        const selectedServices = filterServicesByHandlingStatus(
            allActiveServices,
            statusFilter
        );

        const hostIssueMap = new Map();

        selectedServices.forEach((service) => {
            const hostId =
                service.host?.id ??
                service.host?.host_id ??
                service.host_id;

            if (hostId === undefined || hostId === null) {
                return;
            }

            const hostKey = String(hostId);

            if (!hostIssueMap.has(hostKey)) {
                hostIssueMap.set(hostKey, {
                    critical: 0,
                    warning: 0,
                    unknown: 0,
                    allActiveIssues: 0
                });
            }

            const hostCounts = hostIssueMap.get(hostKey);

            if (Number(service.statusCode) === 2) {
                hostCounts.critical += 1;
            } else if (Number(service.statusCode) === 1) {
                hostCounts.warning += 1;
            } else if (Number(service.statusCode) === 3) {
                hostCounts.unknown += 1;
            }

            hostCounts.allActiveIssues =
                hostCounts.critical +
                hostCounts.warning +
                hostCounts.unknown;
        });

        const centreonPageLimit = 1000;
        let centreonPage = 1;
        let fetchedGroups = 0;
        let totalGroupsFromCentreon = 0;
        const allHostGroups = [];

        while (true) {
            const params = new URLSearchParams({
                page: String(centreonPage),
                limit: String(centreonPageLimit),
                show_host: "true"
            });

            const endpoint = `/monitoring/hostgroups?${params.toString()}`;
            console.log("Centreon Data Center host groups URL:", endpoint);

            const response = await centreonAxios.get(endpoint, {
                headers: getCentreonHeaders(req)
            });

            const groups = response.data?.result || [];
            totalGroupsFromCentreon =
                Number(response.data?.meta?.total) ||
                groups.length;

            allHostGroups.push(...groups);
            fetchedGroups += groups.length;

            if (
                fetchedGroups >= totalGroupsFromCentreon ||
                groups.length === 0
            ) {
                break;
            }

            centreonPage += 1;
        }

        const zeroCounts = () => ({
            allActiveIssues: 0,
            critical: 0,
            warning: 0,
            unknown: 0
        });

        let summaries = allHostGroups.map((group) => {
            const rawHosts = Array.isArray(group.hosts)
                ? group.hosts
                : Array.isArray(group.host)
                    ? group.host
                    : [];

            const groupCounts = zeroCounts();
            let hostsWithIssues = 0;

            const hosts = rawHosts.map((host) => {
                const hostId = host.id ?? host.host_id;
                const counts =
                    hostIssueMap.get(String(hostId)) ||
                    zeroCounts();

                if (counts.allActiveIssues > 0) {
                    hostsWithIssues += 1;
                }

                groupCounts.critical += counts.critical;
                groupCounts.warning += counts.warning;
                groupCounts.unknown += counts.unknown;
                groupCounts.allActiveIssues += counts.allActiveIssues;

                return {
                    id: hostId,
                    name: host.name || "",
                    alias: host.alias || "",
                    display_name:
                        host.display_name ||
                        host.name ||
                        "",
                    state: host.state ?? null,
                    counts: { ...counts }
                };
            });

            const result = {
                id: group.id ?? group.hostgroup_id,
                name:
                    group.name ||
                    group.alias ||
                    `Host Group ${group.id ?? group.hostgroup_id ?? ""}`,
                alias: group.alias || "",
                hostCount: rawHosts.length,
                hostsWithIssues,
                counts: groupCounts
            };

            if (includeHosts) {
                result.hosts = hosts;
            }

            return result;
        });

        if (search) {
            summaries = summaries.filter((group) => {
                const groupName = String(group.name || "").toLowerCase();
                const groupAlias = String(group.alias || "").toLowerCase();
                return (
                    groupName.includes(search) ||
                    groupAlias.includes(search)
                );
            });
        }

        summaries.sort((a, b) => {
            if (b.counts.critical !== a.counts.critical) {
                return b.counts.critical - a.counts.critical;
            }
            if (b.counts.allActiveIssues !== a.counts.allActiveIssues) {
                return b.counts.allActiveIssues - a.counts.allActiveIssues;
            }
            return String(a.name).localeCompare(String(b.name));
        });

        const filteredGroupTotal = summaries.length;
        const startIndex = (page - 1) * limit;
        const pagedSummaries = summaries.slice(
            startIndex,
            startIndex + limit
        );

        const uniqueHostIds = new Set();
        summaries.forEach((group) => {
            const originalGroup = allHostGroups.find(
                (item) =>
                    String(item.id ?? item.hostgroup_id) ===
                    String(group.id)
            );
            const hosts = Array.isArray(originalGroup?.hosts)
                ? originalGroup.hosts
                : Array.isArray(originalGroup?.host)
                    ? originalGroup.host
                    : [];
            hosts.forEach((host) => {
                const hostId = host.id ?? host.host_id;
                if (hostId !== undefined && hostId !== null) {
                    uniqueHostIds.add(String(hostId));
                }
            });
        });

        const overallCounts = zeroCounts();
        let hostsWithIssues = 0;

        uniqueHostIds.forEach((hostId) => {
            const counts = hostIssueMap.get(hostId) || zeroCounts();
            if (counts.allActiveIssues > 0) {
                hostsWithIssues += 1;
            }
            overallCounts.critical += counts.critical;
            overallCounts.warning += counts.warning;
            overallCounts.unknown += counts.unknown;
            overallCounts.allActiveIssues += counts.allActiveIssues;
        });

        return res.json({
            success: true,
            cached: true,
            refreshing: dashboardGlobalSummaryCache.isRefreshing,
            statusFilter,
            query: { search, includeHosts },
            counts: {
                hostGroups: filteredGroupTotal,
                uniqueHosts: uniqueHostIds.size,
                hostsWithIssues,
                ...overallCounts
            },
            data: { result: pagedSummaries },
            meta: {
                page,
                limit,
                total: filteredGroupTotal,
                totalPages: Math.max(
                    1,
                    Math.ceil(filteredGroupTotal / limit)
                ),
                totalGroupsFromCentreon,
                cacheLoaded: true,
                cacheFresh,
                cacheRefreshing: dashboardGlobalSummaryCache.isRefreshing,
                cacheUpdatedAt: dashboardGlobalSummaryCache.updatedAt,
                cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS,
                totalActiveServicesCached: allActiveServices.length,
                totalServicesInSelectedView: selectedServices.length
            }
        });
    } catch (error) {
        console.error("Failed to get Data Center host groups:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        });
        return handleCentreonError(error, res, next);
    }
};

// ============================================================
// ACKNOWLEDGEMENT ACTIONS
// ============================================================

const resolveServiceResourceIds = async (req, targetHost, targetService) => {
    if (
        req.body.hostId !== undefined &&
        req.body.hostId !== null &&
        req.body.serviceId !== undefined &&
        req.body.serviceId !== null
    ) {
        return {
            hostId: Number(req.body.hostId),
            serviceId: Number(req.body.serviceId)
        };
    }

    const attempts = [];

    const runSearch = async (label, searchObject) => {
        try {
            const endpoint = buildServicesEndpoint({
                page: 1,
                limit: 100,
                search: searchObject
            });

            console.log(`Centreon resolve acknowledge resource [${label}]:`, endpoint);

            const response = await centreonAxios.get(endpoint, {
                headers: getCentreonHeaders(req)
            });

            const services = (response.data?.result || []).map(normalizeService);

            attempts.push({
                label,
                success: true,
                count: services.length
            });

            return services;

        } catch (error) {
            console.warn(`Resolve acknowledge search failed [${label}]`, {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            });

            attempts.push({
                label,
                success: false,
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            });

            return [];
        }
    };

    let candidates = [];

    if (targetService) {
        const serviceResults = await runSearch("service.description", {
            "service.description": targetService
        });

        candidates.push(...serviceResults);
    }

    if (targetHost) {
        const hostResults = await runSearch("host.name", {
            "host.name": targetHost
        });

        candidates.push(...hostResults);
    }

    const merged = new Map();

    candidates.forEach((service) => {
        const key = service.id || `${service.host?.id}-${service.description}`;
        merged.set(key, service);
    });

    candidates = Array.from(merged.values());

    const hostLower = String(targetHost || "").toLowerCase();
    const serviceLower = String(targetService || "").toLowerCase();

    const exactMatch = candidates.find((item) => {
        const itemHostName = String(item.host?.name || item.host?.display_name || "").toLowerCase();
        const itemServiceName = String(item.description || item.display_name || "").toLowerCase();

        return itemHostName === hostLower && itemServiceName === serviceLower;
    });

    const looseMatch = candidates.find((item) => {
        const itemHostName = String(item.host?.name || item.host?.display_name || "").toLowerCase();
        const itemServiceName = String(item.description || item.display_name || "").toLowerCase();

        return itemHostName.includes(hostLower) && itemServiceName.includes(serviceLower);
    });

    const matchedService = exactMatch || looseMatch;

    if (!matchedService?.id || !matchedService?.host?.id) {
        const error = new Error("Unable to resolve Centreon host/service IDs for acknowledgement.");
        error.debug = {
            targetHost,
            targetService,
            attempts,
            candidateCount: candidates.length
        };
        throw error;
    }

    return {
        hostId: Number(matchedService.host.id),
        serviceId: Number(matchedService.id)
    };
};

const acknowledgeService = async (req, res, next) => {
    const {
        host,
        service,
        hostName,
        serviceDescription,
        hostAddress,
        comment
    } = req.body;

    const targetHost = host || hostName;
    const targetService = service || serviceDescription;
    const actionBy = getRequestUserName(req);

    if (!targetHost || !targetService) {
        return res.status(400).json({
            success: false,
            message: "host and service are required."
        });
    }

    const acknowledgeComment =
        comment ||
        `Acknowledged from GOC Dashboard by ${actionBy}`;

    let resolvedResource = null;

    try {
        const { hostId, serviceId } = await resolveServiceResourceIds(
            req,
            targetHost,
            targetService
        );

        resolvedResource = {
            hostId,
            serviceId
        };

        const payload = {
            resources: [
                {
                    type: "service",
                    id: serviceId,
                    parent: {
                        id: hostId
                    }
                }
            ],
            acknowledgement: {
                comment: acknowledgeComment
            }
        };

        console.log("Centreon acknowledge payload:", payload);

        const centreonResponse = await centreonAxios.post(
            "/monitoring/resources/acknowledge",
            payload,
            {
                headers: getCentreonHeaders(req)
            }
        );

        const cachePatchedCount = markDashboardCachedServiceAsAcknowledged({
            hostId,
            serviceId,
            hostName: targetHost,
            serviceDescription: targetService,
            comment: acknowledgeComment,
            actionBy
        });

        let auditLogged = false;
        let auditError = null;
        let auditLogId = null;
        let auditServerId = null;

        try {
            const auditResult = await writeAuditLog({
                host: targetHost,
                hostAddress,
                service: targetService,
                logType: "ACKNOWLEDGEMENT",
                oldStatus: null,
                newStatus: "ACKNOWLEDGED",
                actionBy,
                message: acknowledgeComment
            });

            auditLogged = true;
            auditLogId = auditResult.auditLogId;
            auditServerId = auditResult.serverId;

        } catch (logError) {
            auditError = {
                message: logError.message,
                code: logError.code,
                sqlMessage: logError.sqlMessage
            };

            console.error("Acknowledgement succeeded but audit log failed:", auditError);
        }

        return res.json({
            success: true,
            message: "Service acknowledged successfully.",
            auditLogged,
            auditLogId,
            auditServerId,
            auditError,
            cachePatchedCount,
            updatedCounts:
                dashboardGlobalSummaryCache.counts,
            resource: {
                host: targetHost,
                service: targetService,
                hostId,
                serviceId,
                hostAddress: hostAddress || null
            },
            centreon: centreonResponse.data
        });

    } catch (error) {
        console.error("Acknowledge failed:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message,
            debug: error.debug,
            resolvedResource
        });

        try {
            await writeAuditLog({
                host: targetHost,
                hostAddress,
                service: targetService,
                logType: "ACKNOWLEDGEMENT_FAILED",
                oldStatus: null,
                newStatus: "FAILED",
                actionBy,
                message: `Failed to acknowledge ${targetHost} / ${targetService}: ${error.response?.data?.message || error.message}`
            });
        } catch (logError) {
            console.error("Failed to write failed-ack audit log:", {
                message: logError.message,
                code: logError.code,
                sqlMessage: logError.sqlMessage
            });
        }

        return handleCentreonError(error, res, next);
    }
};

const unacknowledgeService = async (req, res, next) => {
    const {
        host,
        service,
        hostAddress,
        hostName,
        serviceDescription
    } = req.body;

    const targetHost = host || hostName;
    const targetService = service || serviceDescription;
    const actionBy = getRequestUserName(req);

    if (!targetHost || !targetService) {
        return res.status(400).json({
            success: false,
            message: "host and service are required."
        });
    }

    let resolvedResource = null;

    try {
        const { hostId, serviceId } = await resolveServiceResourceIds(
            req,
            targetHost,
            targetService
        );

        resolvedResource = {
            hostId,
            serviceId
        };

        const payload = {
            resources: [
                {
                    type: "service",
                    id: serviceId,
                    parent: {
                        id: hostId
                    }
                }
            ]
        };

        const centreonResponse = await sendCentreonUnacknowledgeRequest(req, payload);

        const cachePatchedCount = markDashboardCachedServiceAsUnacknowledged({
            hostId,
            serviceId,
            hostName: targetHost,
            serviceDescription: targetService
        });

        let auditLogged = false;
        let auditError = null;
        let auditLogId = null;
        let auditServerId = null;

        try {
            const auditResult = await writeAuditLog({
                host: targetHost,
                hostAddress,
                service: targetService,
                logType: "UNACKNOWLEDGEMENT",
                oldStatus: "ACKNOWLEDGED",
                newStatus: "PENDING",
                actionBy,
                message: `Unacknowledged from GOC Dashboard by ${actionBy}`
            });

            auditLogged = true;
            auditLogId = auditResult.auditLogId;
            auditServerId = auditResult.serverId;

        } catch (logError) {
            auditError = {
                message: logError.message,
                code: logError.code,
                sqlMessage: logError.sqlMessage
            };

            console.error("Unacknowledgement succeeded but audit log failed:", auditError);
        }

       return res.json({
            success: true,
            message: "Service unacknowledged successfully.",
            auditLogged,
            auditLogId,
            auditServerId,      
            auditError,
            cachePatchedCount,
            updatedCounts:
                dashboardGlobalSummaryCache.counts,
            resource: {
                host: targetHost,
                service: targetService,
                hostId,
                serviceId,
                hostAddress: hostAddress || null
            },
            centreon: centreonResponse.data
        });

    } catch (error) {
        console.error("Unacknowledge failed:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message,
            debug: error.debug,
            resolvedResource
        });

        try {
            await writeAuditLog({
                host: targetHost,
                hostAddress,
                service: targetService,
                logType: "UNACKNOWLEDGEMENT_FAILED",
                oldStatus: "ACKNOWLEDGED",
                newStatus: "FAILED",
                actionBy,
                message: `Failed to unacknowledge ${targetHost} / ${targetService}: ${error.response?.data?.message || error.message}`
            });
        } catch (logError) {
            console.error("Failed to write failed-unack audit log:", {
                message: logError.message,
                code: logError.code,
                sqlMessage: logError.sqlMessage
            });
        }

        return res.status(error.response?.status || 500).json({
            success: false,
            message: error.message || "Unacknowledge failed.",
            status: error.response?.status,
            data: error.response?.data,
            debug: error.debug || null
        });
    }
};

// ============================================================
// DEBUG ENDPOINT
// ============================================================

const testMonitoringServers = async (req, res, next) => {
    try {
        const allServers = [];
        const limit = Number(req.query.limit) || 1000;
        let page = 1;
        let counted = 0;
        let totalFromCentreon = 0;

        while (true) {
            const endpoint = `/configuration/monitoring-servers?page=${page}&limit=${limit}`;

            console.log("Centreon testMonitoringServers URL:", endpoint);

            const response = await centreonAxios.get(endpoint, {
                headers: getCentreonHeaders(req)
            });

            const servers =
                response.data?.result ||
                response.data?.data?.result ||
                response.data?.items ||
                response.data?.data ||
                [];

            totalFromCentreon =
                response.data?.meta?.total ||
                response.data?.data?.meta?.total ||
                servers.length;

            allServers.push(...servers);
            counted += servers.length;

            if (counted >= totalFromCentreon || servers.length === 0) break;
            page += 1;
        }

        return res.json({
            success: true,
            count: allServers.length,
            data: {
                result: allServers
            },
            meta: {
                total: allServers.length
            }
        });

    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    getAllHosts,
    getHostById,
    getHostStatus,
    getAllPollers,
    getPollerHosts,
    getPollerServiceSummary,
    getAllServices,
    getServicesByHost,
    searchServicesGlobally,
    getServiceStatusSummary,
    getGlobalServiceStatusSummary,
    getGlobalServiceStatusSummaryList,
    acknowledgeService,
    unacknowledgeService,
    testMonitoringServers,
    getDataCenterHostGroups
};