import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import "../Logs.css";

// Pull API URL from environment variables or window config
const API_URL = import.meta.env.VITE_API_BASE_URL || window.API_URL || 'http://localhost:5000';

export default function Logs() {
    const navigate = useNavigate();

    // --- State Management for Filters ---
    const [search, setSearch] = useState("");
    const [eventType, setEventType] = useState("all");
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    
    // --- Active Applied Filter States ---
    const [appliedFilters, setAppliedFilters] = useState({
        search: "",
        eventType: "all",
        fromDate: "",
        toDate: ""
    });

    const [logs, setLogs] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null); // Track API errors explicitly
    const [lastUpdate, setLastUpdate] = useState("--");

    // --- Action Handlers ---
    const handleApplyFilters = () => {
        setAppliedFilters({ search, eventType, fromDate, toDate });
    };

    const handleClearFilters = () => {
        setSearch("");
        setEventType("all");
        setFromDate("");
        setToDate("");
        setError(null);
        setAppliedFilters({ search: "", eventType: "all", fromDate: "", toDate: "" });
    };

    // --- Data Fetching Engine ---
    useEffect(() => {
        const token = localStorage.getItem('centreon_auth_token');
        
        // Security check: early exit if unauthenticated
        if (!token) {
            navigate('/login');
            return;
        }

        const controller = new AbortController();
        const { signal } = controller;

        const fetchLogs = async () => {
            setIsLoading(true);
            setError(null);
            
            try {
                const params = new URLSearchParams({
                    search: appliedFilters.search,
                    type: appliedFilters.eventType,
                    from: appliedFilters.fromDate,
                    to: appliedFilters.toDate
                });

                const response = await fetch(`${API_URL}/api/logs?${params.toString()}`, {
                    signal, // Hook abort signal to fetch
                    headers: { 
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) throw new Error("Failed to fetch audit logs");

                const data = await response.json();
                
                if (!signal.aborted) {
                    setLogs(data.result || []);
                    setLastUpdate(new Date().toLocaleTimeString());
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error("Log fetch failed:", err);
                    setError("Failed to load audit records. Please try again later.");
                }
            } finally {
                if (!signal.aborted) {
                    setIsLoading(false);
                }
            }
        };

        fetchLogs();

        // Cleanup: Abort outstanding request if filters change or component unmounts
        return () => {
            controller.abort();
        };
    }, [appliedFilters, navigate]);

    return (
        <div className="logs-container">
            <div className="logs-header">
                <div className="header-top-row">
                    <h2>📜 Event History / Audit Log</h2>
                    <span className="last-update-badge">Last update: {lastUpdate}</span>
                </div>
                
                <div className="logs-filter-row">
                    <div className="filter-group">
                        <label>Search Host or Service:</label>
                        <input 
                            type="text" 
                            className="filter-input-small" 
                            placeholder="Search..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                    
                    <div className="filter-group">
                        <label>Event Type:</label>
                        <select 
                            className="filter-select-small"
                            value={eventType}
                            onChange={(e) => setEventType(e.target.value)}
                        >
                            <option value="all">All Events</option>
                            <option value="critical">🔴 Critical</option>
                            <option value="warning">🟠 Warning</option>
                            <option value="unknown">⚪ Unknown</option>
                            <option value="acknowledged">🟢 Acknowledged</option>
                            <option value="unacknowledged">⚪ Unacknowledged</option>
                        </select>
                    </div>
                    
                    <div className="filter-group">
                        <label>From:</label>
                        <input 
                            type="date" 
                            className="date-filter-input"
                            value={fromDate}
                            onChange={(e) => setFromDate(e.target.value)}
                        />
                    </div>
                    
                    <div className="filter-group">
                        <label>To:</label>
                        <input 
                            type="date" 
                            className="date-filter-input"
                            value={toDate}
                            onChange={(e) => setToDate(e.target.value)}
                        />
                    </div>
                    
                    <div className="filter-actions">
                        <button className="filter-btn" onClick={handleApplyFilters}>Apply</button>
                        <button className="filter-btn clear-btn" onClick={handleClearFilters}>Clear</button>
                    </div>
                </div>
            </div>
            
            <div className="logs-table-wrapper">
                <table className="logs-table">
                    <thead>
                        <tr>
                            <th>Host</th>
                            <th>Service</th>
                            <th>Output</th>
                            <th>Status</th>
                            <th>Timestamp</th>
                        </tr>
                    </thead>
                    <tbody>
                        {isLoading ? (
                            <tr>
                                <td colSpan="5" className="loading-cell">Fetching audit records...</td>
                            </tr>
                        ) : error ? (
                            <tr>
                                <td colSpan="5" className="error-cell" style={{ color: 'var(--error-color, #ff4d4f)', textAlign: 'center', padding: '20px' }}>
                                    🛑 {error}
                                </td>
                            </tr>
                        ) : logs.length === 0 ? (
                            <tr>
                                <td colSpan="5" className="loading-cell">
                                    No records found. 
                                    <button className="reset-link" onClick={handleClearFilters}>Reset filters</button>
                                </td>
                            </tr>
                        ) : (
                            logs.map((log, idx) => (
                                <tr key={idx}>
                                    <td>{log.host_name}</td>
                                    <td>{log.service_name}</td>
                                    <td>{log.output}</td>
                                    <td>{log.status}</td>
                                    <td>{new Date(log.timestamp).toLocaleString()}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}