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

// --- Unhandled Cache (existing) ---
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

// --- All Active Services Cache (new) ---
let allActiveServicesCache = {
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

// Read-only parity cache (unchanged)
let dashboardResourcesParityCache = {
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
    diagnostics: {
        totalFetched: 0,
        totalUnique: 0,
        duplicatesRemoved: 0,
        pagesFetched: 0,
        byStatus: {}
    },
    updatedAt: null,
    isRefreshing: false,
    lastError: null
};

const DASHBOARD_RESOURCES_PARITY_CACHE_TTL_MS = 5 * 60 * 1000;
const DASHBOARD_RESOURCES_PAGE_LIMIT = 100;
const DASHBOARD_RESOURCE_STATUSES = [
    "CRITICAL",
    "WARNING",
    "UNKNOWN"
];

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

// Modified to accept optional `states` parameter
const buildResourcesEndpoint = ({
    page = 1,
    limit = DASHBOARD_RESOURCES_PAGE_LIMIT,
    statuses = DASHBOARD_RESOURCE_STATUSES,
    states = null // if not provided, omit the 'states' parameter
}) => {
    const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sort_by: JSON.stringify({
            status_severity_code: "desc",
            last_status_change: "desc"
        }),
        search: JSON.stringify({
            $and: []
        }),
        status_types: JSON.stringify(["hard"]),
        types: JSON.stringify(["service"]),
        statuses: JSON.stringify(statuses)
    });

    if (states) {
        params.set("states", JSON.stringify(states));
    }

    return `/monitoring/resources?${params.toString()}`;
};

const getResourceIdentity = (resource) => {
    const uuid = String(resource.uuid || "").trim();
    if (uuid) return uuid;

    const hostId =
        resource.host_id ??
        resource.parent?.id;
    const serviceId =
        resource.service_id ??
        resource.id;

    if (
        hostId !== undefined &&
        hostId !== null &&
        serviceId !== undefined &&
        serviceId !== null
    ) {
        return `${hostId}:${serviceId}`;
    }

    const hostName = String(
        resource.parent?.name || "unknown-host"
    ).trim().toLowerCase();
    const serviceName = String(
        resource.name ||
        resource.alias ||
        "unknown-service"
    ).trim().toLowerCase();

    return `${hostName}:${serviceName}`;
};

const normalizeResourceService = (resource) => {
    const statusCode = Number(resource.status?.code);
    const statusName = String(
        resource.status?.name ||
        getStatusNameFromCode(statusCode)
    ).toUpperCase();
    const parentStatusCode = Number(
        resource.parent?.status?.code
    );
    const isAcknowledged = Boolean(
        resource.is_acknowledged
    );
    const isInDowntime = Boolean(
        resource.is_in_downtime
    );
    const tries = String(resource.tries || "");

    return {
        id: resource.service_id ?? resource.id,
        service_id: resource.service_id ?? resource.id,
        description:
            resource.name ||
            resource.alias ||
            "Unknown Service",
        display_name:
            resource.name ||
            resource.alias ||
            "Unknown Service",
        host: {
            id: resource.host_id ?? resource.parent?.id,
            name:
                resource.parent?.name ||
                "Unknown Host",
            display_name:
                resource.parent?.name ||
                "Unknown Host",
            alias:
                resource.parent?.alias ||
                resource.parent?.name ||
                "",
            address:
                resource.parent?.fqdn ||
                "",
            state: Number.isFinite(parentStatusCode)
                ? parentStatusCode
                : null,
            status: resource.parent?.status || null
        },
        state: statusCode,
        state_type: tries.includes("(H)") ? 1 : null,
        status: resource.status || {
            code: statusCode,
            name: statusName
        },
        statusCode,
        statusName,
        is_acknowledged: isAcknowledged,
        acknowledged: isAcknowledged,
        acknowledgement: null,
        is_in_downtime: isInDowntime,
        scheduled_downtime_depth: isInDowntime ? 1 : 0,
        output: resource.information || "",
        poller_name:
            resource.monitoring_server_name ||
            "Default Poller",
        duration: resource.duration || "",
        last_check: resource.last_check || null,
        last_state_change:
            resource.last_status_change ||
            null,
        check_attempt: tries,
        resource_uuid: resource.uuid || null,
        resource_type: resource.type || "service",
        has_active_checks_enabled:
            resource.has_active_checks_enabled,
        has_passive_checks_enabled:
            resource.has_passive_checks_enabled,
        is_notification_enabled:
            resource.is_notification_enabled
    };
};

// --- Fetch unhandled resources (with states filter) ---
const fetchUnhandledHardResourcesByStatus = async (
    req,
    statusName
) => {
    const uniqueResources = new Map();
    let page = 1;
    let totalFromCentreon = 0;
    let totalFetched = 0;
    let pagesFetched = 0;

    while (true) {
        const endpoint = buildResourcesEndpoint({
            page,
            limit: DASHBOARD_RESOURCES_PAGE_LIMIT,
            statuses: [statusName],
            states: ["unhandled_problems"]
        });

        console.log(
            `Centreon Resources parity URL [${statusName}]:`,
            endpoint
        );

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        const resources =
            response.data?.result ||
            response.data?.data?.result ||
            [];
        const meta =
            response.data?.meta ||
            response.data?.data?.meta ||
            {};

        totalFromCentreon = Number(meta.total) || resources.length;
        totalFetched += resources.length;
        pagesFetched += 1;

        resources.forEach((resource) => {
            if (resource.type && resource.type !== "service") {
                return;
            }

            const currentStatus = String(
                resource.status?.name || ""
            ).toUpperCase();

            if (currentStatus !== statusName) {
                return;
            }

            uniqueResources.set(
                getResourceIdentity(resource),
                resource
            );
        });

        if (
            resources.length === 0 ||
            totalFetched >= totalFromCentreon
        ) {
            break;
        }

        page += 1;
    }

    const normalizedServices = Array.from(
        uniqueResources.values()
    ).map(normalizeResourceService);

    return {
        status: statusName,
        services: normalizedServices,
        centreonTotal: totalFromCentreon,
        totalFetched,
        totalUnique: normalizedServices.length,
        duplicatesRemoved: Math.max(
            0,
            totalFetched - normalizedServices.length
        ),
        pagesFetched
    };
};

// --- Fetch all active resources (without states filter) ---
const fetchAllActiveResources = async (req) => {
    const uniqueResources = new Map();
    let page = 1;
    let totalFromCentreon = 0;
    let totalFetched = 0;
    let pagesFetched = 0;

    while (true) {
        const endpoint = buildResourcesEndpoint({
            page,
            limit: DASHBOARD_RESOURCES_PAGE_LIMIT,
            statuses: DASHBOARD_RESOURCE_STATUSES,
            states: null // no states filter -> all active resources
        });

        console.log("Centreon All Active Resources URL:", endpoint);

        const response = await centreonAxios.get(endpoint, {
            headers: getCentreonHeaders(req)
        });

        const resources =
            response.data?.result ||
            response.data?.data?.result ||
            [];
        const meta =
            response.data?.meta ||
            response.data?.data?.meta ||
            {};

        totalFromCentreon = Number(meta.total) || resources.length;
        totalFetched += resources.length;
        pagesFetched += 1;

        resources.forEach((resource) => {
            if (resource.type && resource.type !== "service") {
                return;
            }

            const currentStatus = String(
                resource.status?.name || ""
            ).toUpperCase();

            if (!DASHBOARD_RESOURCE_STATUSES.includes(currentStatus)) {
                return;
            }

            uniqueResources.set(
                getResourceIdentity(resource),
                resource
            );
        });

        if (
            resources.length === 0 ||
            totalFetched >= totalFromCentreon
        ) {
            break;
        }

        page += 1;
    }

    const normalizedServices = Array.from(
        uniqueResources.values()
    ).map(normalizeResourceService);

    return {
        services: normalizedServices,
        centreonTotal: totalFromCentreon,
        totalFetched,
        totalUnique: normalizedServices.length,
        duplicatesRemoved: Math.max(
            0,
            totalFetched - normalizedServices.length
        ),
        pagesFetched
    };
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
    const unhandledServices = getDashboardCachedActiveServices();
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
    serviceDescription
}) => {
    let removedCount = 0;
    const targetHostName = String(hostName || "").trim().toLowerCase();
    const targetServiceDescription = String(
        serviceDescription || ""
    ).trim().toLowerCase();

    const isTargetService = (service) => {
        const currentServiceId =
            service.id ?? service.service_id ?? service.serviceId;
        const currentHostId =
            service.host?.id ?? service.host?.host_id ?? service.host_id;
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

        if (
            hostId !== undefined && hostId !== null &&
            serviceId !== undefined && serviceId !== null
        ) {
            return (
                String(currentHostId) === String(hostId) &&
                String(currentServiceId) === String(serviceId)
            );
        }

        if (serviceId !== undefined && serviceId !== null) {
            return String(currentServiceId) === String(serviceId);
        }

        return (
            currentHostName === targetHostName &&
            currentServiceDescription === targetServiceDescription
        );
    };

    const removeTarget = (services = []) => services.filter((service) => {
        const matches = isTargetService(service);
        if (matches) removedCount += 1;
        return !matches;
    });

    dashboardGlobalSummaryCache = {
        ...dashboardGlobalSummaryCache,
        services: {
            critical: removeTarget(
                dashboardGlobalSummaryCache.services.critical
            ),
            warning: removeTarget(
                dashboardGlobalSummaryCache.services.warning
            ),
            unknown: removeTarget(
                dashboardGlobalSummaryCache.services.unknown
            )
        }
    };

    const updatedCounts = recalculateDashboardGlobalCounts();
    console.log("Dashboard ACK unhandled-cache removal:", {
        removedCount,
        hostId,
        serviceId,
        hostName,
        serviceDescription,
        updatedCounts
    });
    return removedCount;
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

// --- Refresh Unhandled Cache ---
const refreshDashboardGlobalSummaryCache = async (req) => {
    if (dashboardGlobalSummaryCache.isRefreshing) {
        return;
    }

    dashboardGlobalSummaryCache = {
        ...dashboardGlobalSummaryCache,
        isRefreshing: true
    };

    try {
        const results = [];

        for (const statusName of DASHBOARD_RESOURCE_STATUSES) {
            const result = await fetchUnhandledHardResourcesByStatus(
                req,
                statusName
            );

            if (result.totalFetched < result.centreonTotal) {
                const incompleteError = new Error(
                    `Incomplete Centreon Resources refresh for ${statusName}.`
                );
                incompleteError.debug = result;
                throw incompleteError;
            }

            results.push(result);
        }

        const resultByStatus = Object.fromEntries(
            results.map((result) => [result.status, result])
        );
        const criticalServices =
            resultByStatus.CRITICAL?.services || [];
        const warningServices =
            resultByStatus.WARNING?.services || [];
        const unknownServices =
            resultByStatus.UNKNOWN?.services || [];

        const counts = {
            critical: criticalServices.length,
            warning: warningServices.length,
            unknown: unknownServices.length
        };
        counts.allActiveIssues =
            counts.critical + counts.warning + counts.unknown;

        const diagnostics = results.reduce(
            (summary, result) => {
                summary.totalFetched += result.totalFetched;
                summary.totalUnique += result.totalUnique;
                summary.duplicatesRemoved += result.duplicatesRemoved;
                summary.pagesFetched += result.pagesFetched;
                summary.byStatus[result.status.toLowerCase()] = {
                    centreonTotal: result.centreonTotal,
                    totalFetched: result.totalFetched,
                    totalUnique: result.totalUnique,
                    duplicatesRemoved: result.duplicatesRemoved,
                    pagesFetched: result.pagesFetched
                };
                return summary;
            },
            {
                totalFetched: 0,
                totalUnique: 0,
                duplicatesRemoved: 0,
                pagesFetched: 0,
                byStatus: {}
            }
        );

        dashboardGlobalSummaryCache = {
            counts,
            services: {
                critical: criticalServices,
                warning: warningServices,
                unknown: unknownServices
            },
            source: "centreon-monitoring-resources",
            filters: {
                states: ["unhandled_problems"],
                statusTypes: ["hard"],
                types: ["service"],
                statuses: [...DASHBOARD_RESOURCE_STATUSES]
            },
            diagnostics,
            updatedAt: Date.now(),
            isRefreshing: false,
            lastError: null
        };

        console.log("Unhandled cache refreshed:", { counts, diagnostics });
    } catch (error) {
        console.error("Failed refreshing unhandled cache:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message,
            debug: error.debug
        });

        dashboardGlobalSummaryCache = {
            ...dashboardGlobalSummaryCache,
            isRefreshing: false,
            lastError: {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message,
                debug: error.debug || null
            }
        };
    }
};

// --- Refresh All Active Services Cache ---
const refreshAllActiveServicesCache = async (req) => {
    if (allActiveServicesCache.isRefreshing) {
        return;
    }

    allActiveServicesCache = {
        ...allActiveServicesCache,
        isRefreshing: true
    };

    try {
        const result = await fetchAllActiveResources(req);

        const services = result.services || [];
        const criticalServices = services.filter(
            (s) => Number(s.statusCode) === 2
        );
        const warningServices = services.filter(
            (s) => Number(s.statusCode) === 1
        );
        const unknownServices = services.filter(
            (s) => Number(s.statusCode) === 3
        );

        const counts = {
            critical: criticalServices.length,
            warning: warningServices.length,
            unknown: unknownServices.length
        };
        counts.allActiveIssues =
            counts.critical + counts.warning + counts.unknown;

        allActiveServicesCache = {
            counts,
            services: {
                critical: criticalServices,
                warning: warningServices,
                unknown: unknownServices
            },
            source: "centreon-monitoring-resources",
            filters: {
                states: null,
                statusTypes: ["hard"],
                types: ["service"],
                statuses: [...DASHBOARD_RESOURCE_STATUSES]
            },
            diagnostics: {
                totalFetched: result.totalFetched,
                totalUnique: result.totalUnique,
                duplicatesRemoved: result.duplicatesRemoved,
                pagesFetched: result.pagesFetched,
                byStatus: {
                    critical: { count: criticalServices.length },
                    warning: { count: warningServices.length },
                    unknown: { count: unknownServices.length }
                }
            },
            updatedAt: Date.now(),
            isRefreshing: false,
            lastError: null
        };

        console.log("All Active Services cache refreshed:", { counts });
    } catch (error) {
        console.error("Failed refreshing all active services cache:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message,
            debug: error.debug
        });

        allActiveServicesCache = {
            ...allActiveServicesCache,
            isRefreshing: false,
            lastError: {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message,
                debug: error.debug || null
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

const normalizePollerKey = (value) => {
    return String(value || "Default Poller")
        .trim()
        .toLowerCase();
};

const getServicePollerKey = (service) => {
    return normalizePollerKey(
        service.poller_name ||
        service.host?.poller_name ||
        (service.host?.poller_id
            ? `Poller ${service.host.poller_id}`
            : "Default Poller")
    );
};

const getUnhandledServicesByPoller = () => {
    const pollerServices = new Map();

    const addServices = (services = []) => {
        services.forEach((service) => {
            const pollerKey = getServicePollerKey(service);

            if (!pollerServices.has(pollerKey)) {
                pollerServices.set(pollerKey, []);
            }

            pollerServices.get(pollerKey).push(service);
        });
    };

    addServices(dashboardGlobalSummaryCache.services.critical);
    addServices(dashboardGlobalSummaryCache.services.warning);
    addServices(dashboardGlobalSummaryCache.services.unknown);

    return pollerServices;
};

const getAllPollers = async (req, res, next) => {
    try {
        const monitoringServerMap = await getMonitoringServerMap(req);
        const now = Date.now();

        const hostCacheFresh = Boolean(
            pollerHostCountCache.updatedAt &&
            now - pollerHostCountCache.updatedAt <
                POLLER_HOST_COUNT_CACHE_TTL_MS
        );

        if (!hostCacheFresh && !pollerHostCountCache.isRefreshing) {
            refreshPollerHostCountCache(req, monitoringServerMap);
        }

        const serviceCacheFresh = Boolean(
            dashboardGlobalSummaryCache.updatedAt &&
            now - dashboardGlobalSummaryCache.updatedAt <
                DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
        );

        if (!serviceCacheFresh && !dashboardGlobalSummaryCache.isRefreshing) {
            if (!dashboardGlobalSummaryCache.updatedAt) {
                await refreshDashboardGlobalSummaryCache(req);
            } else {
                refreshDashboardGlobalSummaryCache(req);
            }
        }

        const serviceCountsLoaded = Boolean(
            dashboardGlobalSummaryCache.updatedAt
        );
        const servicesByPoller = serviceCountsLoaded
            ? getUnhandledServicesByPoller()
            : new Map();

        const pollers = Object.values(monitoringServerMap)
            .map((server) => {
                const pollerId = String(server.id);
                const hostCounts = pollerHostCountCache.data[pollerId];
                const pollerKey = normalizePollerKey(server.name);
                const pollerServices =
                    servicesByPoller.get(pollerKey) || [];
                const issueCounts = serviceCountsLoaded
                    ? buildStatusCounts(pollerServices)
                    : {
                        allActiveIssues: null,
                        critical: null,
                        warning: null,
                        unknown: null
                    };

                return {
                    poller_id: server.id,
                    poller_name:
                        server.name || `Poller ${server.id}`,
                    address: server.address || "",
                    server_type: server.server_type || "",
                    totalHosts: hostCounts?.totalHosts ?? null,
                    upHosts: hostCounts?.upHosts ?? null,
                    downHosts: hostCounts?.downHosts ?? null,
                    unreachableHosts:
                        hostCounts?.unreachableHosts ?? null,
                    pendingHosts: hostCounts?.pendingHosts ?? null,
                    allActiveIssues: issueCounts.allActiveIssues,
                    criticalServices: issueCounts.critical,
                    warningServices: issueCounts.warning,
                    unknownServices: issueCounts.unknown
                };
            })
            .sort((a, b) => {
                return String(a.poller_name || "").localeCompare(
                    String(b.poller_name || ""),
                    undefined,
                    { sensitivity: "base" }
                );
            });

        return res.json({
            success: true,
            count: pollers.length,
            data: { result: pollers },
            meta: {
                totalPollers: pollers.length,
                hostCountLoaded: Boolean(
                    pollerHostCountCache.updatedAt
                ),
                hostCountFresh: hostCacheFresh,
                hostCountRefreshing:
                    pollerHostCountCache.isRefreshing,
                hostCountUpdatedAt:
                    pollerHostCountCache.updatedAt,
                serviceCountsLoaded,
                serviceCountsFresh: serviceCacheFresh,
                serviceCountsRefreshing:
                    dashboardGlobalSummaryCache.isRefreshing,
                serviceCountsUpdatedAt:
                    dashboardGlobalSummaryCache.updatedAt,
                serviceCountsSource: serviceCountsLoaded
                    ? dashboardGlobalSummaryCache.source ||
                        "centreon-monitoring-resources"
                    : "loading"
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
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(
            1000,
            Math.max(1, Number(req.query.limit) || 100)
        );
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
        const hostSearch = String(req.query.host || "")
            .trim()
            .toLowerCase();
        const serviceSearch = String(req.query.service || "")
            .trim()
            .toLowerCase();

        const monitoringServerMap = await getMonitoringServerMap(req);
        const mappedServer = monitoringServerMap[String(pollerId)];
        const pollerName =
            mappedServer?.name || `Poller ${pollerId}`;
        const pollerKey = normalizePollerKey(pollerName);
        const now = Date.now();
        const serviceCacheFresh = Boolean(
            dashboardGlobalSummaryCache.updatedAt &&
            now - dashboardGlobalSummaryCache.updatedAt <
                DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
        );

        if (!serviceCacheFresh && !dashboardGlobalSummaryCache.isRefreshing) {
            if (!dashboardGlobalSummaryCache.updatedAt) {
                await refreshDashboardGlobalSummaryCache(req);
            } else {
                refreshDashboardGlobalSummaryCache(req);
            }
        }

        if (!dashboardGlobalSummaryCache.updatedAt) {
            return res.json({
                success: true,
                cached: false,
                refreshing:
                    dashboardGlobalSummaryCache.isRefreshing,
                poller_id: pollerId,
                poller_name: pollerName,
                poller_address: mappedServer?.address || "",
                poller_server_type:
                    mappedServer?.server_type || "",
                mode: "cached-resources",
                statusFilter: "unhandled",
                type,
                query: {
                    host: hostSearch,
                    service: serviceSearch
                },
                counts: {
                    allServices: null,
                    allActiveIssues: null,
                    critical: null,
                    warning: null,
                    unknown: null
                },
                filteredCounts: {
                    allActiveIssues: 0,
                    critical: 0,
                    warning: 0,
                    unknown: 0
                },
                options: { hosts: [], services: [] },
                services: {
                    critical: [],
                    warning: [],
                    unknown: []
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
                    cacheRefreshing:
                        dashboardGlobalSummaryCache.isRefreshing,
                    cacheUpdatedAt:
                        dashboardGlobalSummaryCache.updatedAt,
                    cacheTtlMs:
                        DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                }
            });
        }

        const servicesByPoller = getUnhandledServicesByPoller();
        const allPollerServices =
            servicesByPoller.get(pollerKey) || [];
        const pollerCounts = buildStatusCounts(allPollerServices);

        const matchesHost = (service) => {
            if (!hostSearch) return true;

            return [
                service.host?.name,
                service.host?.display_name,
                service.host?.alias
            ].some((value) =>
                String(value || "")
                    .toLowerCase()
                    .includes(hostSearch)
            );
        };

        const matchesService = (service) => {
            if (!serviceSearch) return true;

            return [
                service.description,
                service.display_name,
                service.service_name,
                service.output
            ].some((value) =>
                String(value || "")
                    .toLowerCase()
                    .includes(serviceSearch)
            );
        };

        const searchedServices = allPollerServices.filter(
            (service) =>
                matchesHost(service) && matchesService(service)
        );
        const filteredCounts = buildStatusCounts(searchedServices);

        let selectedServices = searchedServices;

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
        }

        const hostOptions = [
            ...new Set(
                allPollerServices
                    .filter(matchesService)
                    .map((service) =>
                        String(
                            service.host?.name ||
                            service.host?.display_name ||
                            service.host?.alias ||
                            ""
                        ).trim()
                    )
                    .filter(Boolean)
            )
        ].sort((a, b) => a.localeCompare(b));

        const serviceOptions = [
            ...new Set(
                allPollerServices
                    .filter(matchesHost)
                    .map((service) =>
                        String(
                            service.description ||
                            service.display_name ||
                            service.service_name ||
                            ""
                        ).trim()
                    )
                    .filter(Boolean)
            )
        ].sort((a, b) => a.localeCompare(b));

        const startIndex = (page - 1) * limit;
        const pagedServices = selectedServices.slice(
            startIndex,
            startIndex + limit
        );

        return res.json({
            success: true,
            cached: true,
            refreshing:
                dashboardGlobalSummaryCache.isRefreshing,
            source:
                dashboardGlobalSummaryCache.source ||
                "centreon-monitoring-resources",
            poller_id: pollerId,
            poller_name: pollerName,
            poller_address: mappedServer?.address || "",
            poller_server_type:
                mappedServer?.server_type || "",
            mode: "cached-resources",
            statusFilter: "unhandled",
            type,
            query: {
                host: hostSearch,
                service: serviceSearch
            },
            counts: {
                ...pollerCounts,
                allServices: pollerCounts.allActiveIssues
            },
            filteredCounts,
            options: {
                hosts: hostOptions,
                services: serviceOptions
            },
            services: {
                critical: searchedServices.filter(
                    (service) => Number(service.statusCode) === 2
                ),
                warning: searchedServices.filter(
                    (service) => Number(service.statusCode) === 1
                ),
                unknown: searchedServices.filter(
                    (service) => Number(service.statusCode) === 3
                )
            },
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
                totalPollerIssues:
                    pollerCounts.allActiveIssues,
                hostOptionCount: hostOptions.length,
                serviceOptionCount: serviceOptions.length,
                cacheLoaded: true,
                cacheFresh: serviceCacheFresh,
                cacheRefreshing:
                    dashboardGlobalSummaryCache.isRefreshing,
                cacheUpdatedAt:
                    dashboardGlobalSummaryCache.updatedAt,
                cacheTtlMs:
                    DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
            }
        });
    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

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
// SUMMARY ENDPOINTS (UPDATED)
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

// --- Updated: supports statusFilter ---
const getGlobalServiceStatusSummary = async (req, res, next) => {
    try {
        const statusFilter = normalizeStatusFilter(
            req.query.statusFilter || "unhandled"
        );

        const now = Date.now();
        let cacheToUse;

        if (statusFilter === "unhandled") {
            cacheToUse = dashboardGlobalSummaryCache;
            // Trigger refresh if stale
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshDashboardGlobalSummaryCache(req);
            }
        } else {
            cacheToUse = allActiveServicesCache;
            // Trigger refresh if stale
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshAllActiveServicesCache(req);
            }
        }

        // If cache is empty, return empty counts
        if (!cacheToUse.updatedAt) {
            return res.json({
                success: true,
                cached: false,
                refreshing: cacheToUse.isRefreshing,
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
                meta: {
                    cacheLoaded: false,
                    cacheFresh: false,
                    cacheRefreshing: cacheToUse.isRefreshing,
                    cacheUpdatedAt: cacheToUse.updatedAt,
                    cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS,
                    lastError: cacheToUse.lastError
                }
            });
        }

        // Get services from cache and apply manual filter if needed
        let allServices = [
            ...(cacheToUse.services.critical || []),
            ...(cacheToUse.services.warning || []),
            ...(cacheToUse.services.unknown || [])
        ];

        // For "acknowledged" and "all", we need to filter manually
        let filteredServices;
        if (statusFilter === "acknowledged") {
            filteredServices = allServices.filter(isAcknowledgedActiveService);
        } else if (statusFilter === "all") {
            filteredServices = allServices.filter(isActiveIssueService);
        } else {
            // unhandled – cache already contains unhandled, but we can still filter to be safe
            filteredServices = allServices.filter(isUnhandledActiveService);
        }

        const counts = buildStatusCounts(filteredServices);

        return res.json({
            success: true,
            cached: true,
            refreshing: cacheToUse.isRefreshing,
            counts,
            services: {
                critical: filteredServices.filter(s => s.statusCode === 2),
                warning: filteredServices.filter(s => s.statusCode === 1),
                unknown: filteredServices.filter(s => s.statusCode === 3)
            },
            meta: {
                cacheLoaded: true,
                cacheFresh: Boolean(
                    cacheToUse.updatedAt &&
                    now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                ),
                cacheRefreshing: cacheToUse.isRefreshing,
                cacheUpdatedAt: cacheToUse.updatedAt,
                cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS,
                diagnostics: cacheToUse.diagnostics || null,
                lastError: cacheToUse.lastError
            }
        });
    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// --- Updated: supports statusFilter ---
const getGlobalServiceFilterOptions = async (req, res, next) => {
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

        const poller = String(req.query.poller || "")
            .trim()
            .toLowerCase();

        const hostSearch = String(req.query.host || "")
            .trim()
            .toLowerCase();

        const serviceSearch = String(req.query.service || "")
            .trim()
            .toLowerCase();

        const now = Date.now();
        let cacheToUse;

        if (statusFilter === "unhandled") {
            cacheToUse = dashboardGlobalSummaryCache;
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshDashboardGlobalSummaryCache(req);
            }
        } else {
            cacheToUse = allActiveServicesCache;
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshAllActiveServicesCache(req);
            }
        }

        if (!cacheToUse.updatedAt) {
            return res.json({
                success: true,
                cached: false,
                refreshing: cacheToUse.isRefreshing,
                type,
                statusFilter,
                query: {
                    poller,
                    host: hostSearch,
                    service: serviceSearch
                },
                options: {
                    hosts: [],
                    services: []
                },
                meta: {
                    hostCount: 0,
                    serviceCount: 0,
                    cacheLoaded: false,
                    cacheFresh: false,
                    cacheRefreshing: cacheToUse.isRefreshing,
                    cacheUpdatedAt: cacheToUse.updatedAt,
                    cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                }
            });
        }

        let allServices = [
            ...(cacheToUse.services.critical || []),
            ...(cacheToUse.services.warning || []),
            ...(cacheToUse.services.unknown || [])
        ];

        let services;
        if (statusFilter === "acknowledged") {
            services = allServices.filter(isAcknowledgedActiveService);
        } else if (statusFilter === "all") {
            services = allServices.filter(isActiveIssueService);
        } else {
            services = allServices.filter(isUnhandledActiveService);
        }

        // Apply type filter
        if (type === "critical") {
            services = services.filter(
                (service) => Number(service.statusCode) === 2
            );
        } else if (type === "warning") {
            services = services.filter(
                (service) => Number(service.statusCode) === 1
            );
        } else if (type === "unknown") {
            services = services.filter(
                (service) => Number(service.statusCode) === 3
            );
        }

        if (poller && poller !== "all") {
            services = services.filter((service) => {
                const pollerName = String(
                    service.poller_name ||
                    service.host?.poller_name ||
                    (service.host?.poller_id
                        ? `Poller ${service.host.poller_id}`
                        : "Default Poller")
                ).trim().toLowerCase();

                return pollerName === poller;
            });
        }

        const getHostOption = (service) => String(
            service.host?.name ||
            service.host?.display_name ||
            service.host?.alias ||
            ""
        ).trim();

        const getServiceOption = (service) => String(
            service.description ||
            service.display_name ||
            service.service_name ||
            ""
        ).trim();

        const matchesHostSearch = (service) => {
            if (!hostSearch) return true;

            const hostName = String(
                service.host?.name || ""
            ).toLowerCase();
            const hostDisplayName = String(
                service.host?.display_name || ""
            ).toLowerCase();
            const hostAlias = String(
                service.host?.alias || ""
            ).toLowerCase();

            return (
                hostName.includes(hostSearch) ||
                hostDisplayName.includes(hostSearch) ||
                hostAlias.includes(hostSearch)
            );
        };

        const matchesServiceSearch = (service) => {
            if (!serviceSearch) return true;

            const description = String(
                service.description || ""
            ).toLowerCase();
            const displayName = String(
                service.display_name || ""
            ).toLowerCase();

            return (
                description.includes(serviceSearch) ||
                displayName.includes(serviceSearch)
            );
        };

        // Host choices are narrowed by the current service search.
        // Service choices are narrowed by the current host search.
        const hostOptions = [
            ...new Set(
                services
                    .filter(matchesServiceSearch)
                    .map(getHostOption)
                    .filter(Boolean)
            )
        ].sort((a, b) => a.localeCompare(b));

        const serviceOptions = [
            ...new Set(
                services
                    .filter(matchesHostSearch)
                    .map(getServiceOption)
                    .filter(Boolean)
            )
        ].sort((a, b) => a.localeCompare(b));

        return res.json({
            success: true,
            cached: true,
            refreshing: cacheToUse.isRefreshing,
            type,
            statusFilter,
            query: {
                poller,
                host: hostSearch,
                service: serviceSearch
            },
            options: {
                hosts: hostOptions,
                services: serviceOptions
            },
            meta: {
                hostCount: hostOptions.length,
                serviceCount: serviceOptions.length,
                cacheLoaded: true,
                cacheFresh: Boolean(
                    cacheToUse.updatedAt &&
                    now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                ),
                cacheRefreshing: cacheToUse.isRefreshing,
                cacheUpdatedAt: cacheToUse.updatedAt,
                cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
            }
        });
    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// --- Updated: supports statusFilter ---
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
            req.query.statusFilter || "unhandled"
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

        // Determine which cache to use
        let cacheToUse;
        if (statusFilter === "unhandled") {
            cacheToUse = dashboardGlobalSummaryCache;
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshDashboardGlobalSummaryCache(req);
            }
        } else {
            cacheToUse = allActiveServicesCache;
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshAllActiveServicesCache(req);
            }
        }

        if (!cacheToUse.updatedAt) {
            return res.json({
                success: true,
                cached: false,
                refreshing: cacheToUse.isRefreshing,
                type,
                statusFilter,
                query: { host: hostSearch, service: serviceSearch, q: qSearch },
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
                    cacheRefreshing: cacheToUse.isRefreshing,
                    cacheUpdatedAt: cacheToUse.updatedAt,
                    cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                }
            });
        }

        // Get all services from cache
        let allServices = [
            ...(cacheToUse.services.critical || []),
            ...(cacheToUse.services.warning || []),
            ...(cacheToUse.services.unknown || [])
        ];

        // Apply status filter manually for "acknowledged" and "all"
        let handlingFilteredServices;
        if (statusFilter === "acknowledged") {
            handlingFilteredServices = allServices.filter(isAcknowledgedActiveService);
        } else if (statusFilter === "all") {
            handlingFilteredServices = allServices.filter(isActiveIssueService);
        } else {
            // unhandled – cache already contains unhandled
            handlingFilteredServices = allServices.filter(isUnhandledActiveService);
        }

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

        const unhandledTotal = allServices.filter(
            isUnhandledActiveService
        ).length;

        const acknowledgedTotal = allServices.filter(
            isAcknowledgedActiveService
        ).length;

        return res.json({
            success: true,
            cached: true,
            refreshing: cacheToUse.isRefreshing,
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
                cacheFresh: Boolean(
                    cacheToUse.updatedAt &&
                    now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                ),
                cacheRefreshing: cacheToUse.isRefreshing,
                cacheUpdatedAt: cacheToUse.updatedAt,
                cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS,
                totalActiveServicesCached: allServices.length,
                totalUnhandledServices: unhandledTotal,
                totalAcknowledgedServices: acknowledgedTotal
            }
        });
    } catch (error) {
        return handleCentreonError(error, res, next);
    }
};

// ============================================================
// OTHER ENDPOINTS (unchanged)
// ============================================================

const getGlobalServiceResourcesParity = async (
    req,
    res,
    next
) => {
    try {
        const forceRefresh = [
            "1",
            "true",
            "yes"
        ].includes(
            String(req.query.refresh || "")
                .trim()
                .toLowerCase()
        );
        const now = Date.now();
        const cacheLoaded = Boolean(
            dashboardResourcesParityCache.updatedAt &&
            dashboardResourcesParityCache.counts.allActiveIssues !== null
        );
        const cacheFresh = Boolean(
            dashboardResourcesParityCache.updatedAt &&
            now - dashboardResourcesParityCache.updatedAt <
                DASHBOARD_RESOURCES_PARITY_CACHE_TTL_MS
        );

        if (
            (forceRefresh || !cacheFresh) &&
            !dashboardResourcesParityCache.isRefreshing
        ) {
            await refreshDashboardResourcesParityCache(req);
        }

        const refreshedCacheLoaded = Boolean(
            dashboardResourcesParityCache.updatedAt &&
            dashboardResourcesParityCache.counts.allActiveIssues !== null
        );

        return res.json({
            success: true,
            readOnly: true,
            productionDashboardChanged: false,
            source: "centreon-monitoring-resources",
            filters: {
                states: [
                    "unhandled_problems"
                ],
                statusTypes: [
                    "hard"
                ],
                types: [
                    "service"
                ],
                statuses: [
                    "CRITICAL",
                    "WARNING",
                    "UNKNOWN"
                ]
            },
            cached: refreshedCacheLoaded,
            refreshing:
                dashboardResourcesParityCache.isRefreshing,
            counts:
                dashboardResourcesParityCache.counts,
            diagnostics:
                dashboardResourcesParityCache.diagnostics,
            samples: {
                critical:
                    dashboardResourcesParityCache.services.critical.slice(0, 2),
                warning:
                    dashboardResourcesParityCache.services.warning.slice(0, 2),
                unknown:
                    dashboardResourcesParityCache.services.unknown.slice(0, 2)
            },
            meta: {
                cacheLoaded: refreshedCacheLoaded,
                cacheFresh: Boolean(
                    dashboardResourcesParityCache.updatedAt &&
                    Date.now() - dashboardResourcesParityCache.updatedAt <
                        DASHBOARD_RESOURCES_PARITY_CACHE_TTL_MS
                ),
                cacheRefreshing:
                    dashboardResourcesParityCache.isRefreshing,
                cacheUpdatedAt:
                    dashboardResourcesParityCache.updatedAt,
                cacheTtlMs:
                    DASHBOARD_RESOURCES_PARITY_CACHE_TTL_MS,
                pageLimit:
                    DASHBOARD_RESOURCES_PAGE_LIMIT,
                lastError:
                    dashboardResourcesParityCache.lastError
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
        let cacheToUse;

        if (statusFilter === "unhandled") {
            cacheToUse = dashboardGlobalSummaryCache;
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshDashboardGlobalSummaryCache(req);
            }
        } else {
            cacheToUse = allActiveServicesCache;
            const hasFreshCache =
                cacheToUse.updatedAt &&
                now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS;
            if (!hasFreshCache && !cacheToUse.isRefreshing) {
                refreshAllActiveServicesCache(req);
            }
        }

        if (!cacheToUse.updatedAt) {
            return res.json({
                success: true,
                cached: false,
                refreshing: cacheToUse.isRefreshing,
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
                    cacheRefreshing: cacheToUse.isRefreshing,
                    cacheUpdatedAt: cacheToUse.updatedAt,
                    cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                }
            });
        }

        // Get all services from the appropriate cache
        let allServices = [
            ...(cacheToUse.services.critical || []),
            ...(cacheToUse.services.warning || []),
            ...(cacheToUse.services.unknown || [])
        ];

        // Apply status filter manually
        let selectedServices;
        if (statusFilter === "acknowledged") {
            selectedServices = allServices.filter(isAcknowledgedActiveService);
        } else if (statusFilter === "all") {
            selectedServices = allServices.filter(isActiveIssueService);
        } else {
            selectedServices = allServices.filter(isUnhandledActiveService);
        }

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
            refreshing: cacheToUse.isRefreshing,
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
                cacheFresh: Boolean(
                    cacheToUse.updatedAt &&
                    now - cacheToUse.updatedAt < DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS
                ),
                cacheRefreshing: cacheToUse.isRefreshing,
                cacheUpdatedAt: cacheToUse.updatedAt,
                cacheTtlMs: DASHBOARD_GLOBAL_SUMMARY_CACHE_TTL_MS,
                totalActiveServicesCached: allServices.length,
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
        // The production cache is unhandled-only. Re-query Centreon after
        // UNACK instead of inventing a local resource record.
        dashboardGlobalSummaryCache.updatedAt = null;
        refreshDashboardGlobalSummaryCache(req);

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
    getGlobalServiceFilterOptions,
    getGlobalServiceResourcesParity,
    acknowledgeService,
    unacknowledgeService,
    testMonitoringServers,
    getDataCenterHostGroups
};