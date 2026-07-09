// backend/src/controllers/logsController.js
const db = require('../config/db');

// Fetch logs with filters
const getAllLogs = async (req, res) => {
    try {
        const { search, type, from, to } = req.query;

        let query = `
            SELECT
                l.id,
                COALESCE(s.hostname, 'Unknown Host') AS host_name,
                l.service_name AS service_name,
                l.message AS output,
                l.new_status AS status,
                l.created_at AS timestamp,
                l.log_type,
                l.old_status,
                l.new_status,
                l.action_by,
                l.message
            FROM server_activity_log l
            LEFT JOIN servers s ON l.server_id = s.id
            WHERE 1=1
        `;

        const params = [];

        if (search) {
            query += `
                AND (
                    s.hostname LIKE ?
                    OR l.service_name LIKE ?
                    OR l.message LIKE ?
                    OR l.action_by LIKE ?
                )
            `;

            params.push(
                `%${search}%`,
                `%${search}%`,
                `%${search}%`,
                `%${search}%`
            );
        }

        if (type && type !== 'all') {
            if (type === 'acknowledged') {
                query += ` AND l.log_type = ?`;
                params.push('ACKNOWLEDGEMENT');
            } else if (type === 'unacknowledged') {
                query += ` AND l.log_type = ?`;
                params.push('UNACKNOWLEDGEMENT');
            } else if (['critical', 'warning', 'unknown'].includes(type)) {
                query += ` AND l.new_status = ?`;
                params.push(type.toUpperCase());
            }
        }

        if (from) {
            query += ` AND DATE(l.created_at) >= ?`;
            params.push(from);
        }

        if (to) {
            query += ` AND DATE(l.created_at) <= ?`;
            params.push(to);
        }

        query += ` ORDER BY l.created_at DESC, l.id DESC LIMIT 100`;

        const [results] = await db.execute(query, params);

        return res.json({
            success: true,
            result: results
        });

    } catch (error) {
        console.error("Error fetching logs:", {
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage,
            sql: error.sql
        });

        return res.status(500).json({
            success: false,
            error: "Failed to fetch audit records",
            details: error.sqlMessage || error.message
        });
    }
};

// Insert a new log entry manually if needed
const createLogEntry = async (req, res) => {
    try {
        const {
            server_id,
            incident_id,
            service_name,
            log_type,
            old_status,
            new_status,
            action_by,
            message
        } = req.body;

        if (!server_id || !log_type) {
            return res.status(400).json({
                success: false,
                error: "server_id and log_type are required"
            });
        }

        const query = `
            INSERT INTO server_activity_log
            (server_id, incident_id, service_name, log_type, old_status, new_status, action_by, message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const [insertResult] = await db.execute(query, [
            server_id,
            incident_id || null,
            service_name || null,
            log_type,
            old_status || null,
            new_status || null,
            action_by || null,
            message || null
        ]);

        return res.status(201).json({
            success: true,
            message: "Log saved successfully",
            auditLogId: insertResult.insertId
        });

    } catch (error) {
        console.error("Error inserting log:", {
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage
        });

        return res.status(500).json({
            success: false,
            error: "Failed to record activity",
            details: error.sqlMessage || error.message
        });
    }
};

// DB/logs health check
const getLogsHealth = async (req, res) => {
    try {
        const [serverRows] = await db.execute(
            `SELECT COUNT(*) AS totalServers FROM servers`
        );

        const [logRows] = await db.execute(
            `SELECT COUNT(*) AS totalLogs FROM server_activity_log`
        );

        const [latestRows] = await db.execute(
            `
            SELECT
                l.id,
                l.server_id,
                l.incident_id,
                l.service_name,
                l.log_type,
                l.old_status,
                l.new_status,
                l.action_by,
                l.message,
                l.created_at,
                COALESCE(s.hostname, 'Unknown Host') AS host_name,
                s.ip_address
            FROM server_activity_log l
            LEFT JOIN servers s ON l.server_id = s.id
            ORDER BY l.id DESC
            LIMIT 10
            `
        );

        return res.json({
            success: true,
            databaseConnected: true,
            totalServers: serverRows[0]?.totalServers ?? 0,
            totalLogs: logRows[0]?.totalLogs ?? 0,
            latestLogs: latestRows
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            databaseConnected: false,
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage
        });
    }
};

module.exports = {
    getAllLogs,
    createLogEntry,
    getLogsHealth
};