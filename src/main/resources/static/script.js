/* =========================================================
   SMART CAMPUS HUB - Frontend JavaScript
   Backend: CampusHubApplication.java (API under /api)
   ========================================================= */

const API = "/api";

const DEPARTMENTS = ["CSE", "CSE AIML", "AI DS", "ISE", "ECE", "EEE"];

const CERTIFICATE_TYPES = [
    "10th / SSLC Certificate",
    "12th / PUC Certificate",
    "Transfer Certificate",
    "Study Certificate",
    "Conduct Certificate",
    "Bonafide Certificate",
    "Character Certificate",
    "Migration Certificate",
    "Other Certificate"
];

const STATUSES = [
    "Submitted",
    "Under Verification",
    "Processing",
    "Awaiting Approval",
    "Delayed",
    "Need Documents",
    "Ready for Collection",
    "Collected",
    "Rejected"
];

// These groups must match the groups in the Java backend.
const PENDING_STATUSES = ["Submitted", "Under Verification", "Processing", "Awaiting Approval", "Need Documents"];
const COMPLETED_STATUSES = ["Ready for Collection", "Collected"];
const CLOSED_STATUSES = ["Ready for Collection", "Collected", "Rejected"];

const MAX_PDF_SIZE = 10 * 1024 * 1024;

let currentUser = null;
let currentRole = null;
let selectedDepartment = "CSE";
let currentRequests = [];
let currentStudents = [];
let currentSummary = {};
let toastTimer = null;
let busy = false; // stops double clicks and duplicate submissions

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

const app = document.getElementById("app");
const headerActions = document.getElementById("header-actions");

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[character]);
}

function formatDate(value) {
    if (!value) return "Not available";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHTML(value);
    return date.toLocaleString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit"
    });
}

function formatDateOnly(value) {
    if (!value) return "Not specified";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHTML(value);
    return date.toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric"
    });
}

function todayString() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${today.getFullYear()}-${month}-${day}`;
}

function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = "toast"; }, 3500);
}

function setLoading(message = "Loading...") {
    app.innerHTML = `
        <section class="loading-screen">
            <div class="loader"></div>
            <p>${escapeHTML(message)}</p>
        </section>
    `;
}

async function apiRequest(endpoint, options = {}) {
    const config = {
        method: options.method || "GET",
        credentials: "same-origin",
        headers: { ...(options.headers || {}) }
    };

    if (options.body instanceof FormData) {
        config.body = options.body; // the browser sets the content type
    } else if (options.body !== undefined) {
        config.headers["Content-Type"] = "application/json";
        config.body = JSON.stringify(options.body);
    }

    let response;
    try {
        response = await fetch(`${API}${endpoint}`, config);
    } catch (error) {
        throw new Error("Cannot connect to the server. Please make sure Smart Campus Hub is running.");
    }

    let result = {};
    try {
        result = await response.json();
    } catch (error) {
        result = {};
    }

    if (!response.ok) {
        throw new Error(result.message || result.error || `Request failed (${response.status}).`);
    }

    // The Java backend wraps successful responses inside { message, data }.
    return Object.prototype.hasOwnProperty.call(result, "data") ? result.data : result;
}

function statusClass(status) {
    return String(status || "submitted").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function statusBadge(status) {
    return `<span class="status-badge status-${statusClass(status)}">${escapeHTML(status || "Submitted")}</span>`;
}

function emptyMessage(message) {
    return `
        <div class="empty-state">
            <div class="empty-icon">📄</div>
            <h3>${escapeHTML(message)}</h3>
        </div>
    `;
}

function summarize(requests) {
    const today = todayString();
    const result = { total: requests.length, pending: 0, delayed: 0, completed: 0, rejected: 0, overdue: 0 };
    requests.forEach(request => {
        if (PENDING_STATUSES.includes(request.status)) result.pending++;
        if (request.status === "Delayed") result.delayed++;
        if (COMPLETED_STATUSES.includes(request.status)) result.completed++;
        if (request.status === "Rejected") result.rejected++;
        if (request.expectedDate && request.expectedDate < today && !CLOSED_STATUSES.includes(request.status)) {
            result.overdue++;
        }
    });
    return result;
}

function statCard(icon, label, value) {
    return `
        <div class="stat-card">
            <span class="stat-icon">${icon}</span>
            <p>${escapeHTML(label)}</p>
            <h3>${escapeHTML(value)}</h3>
        </div>
    `;
}

function replaceRequest(updated) {
    const index = currentRequests.findIndex(item => String(item.id) === String(updated.id));
    if (index >= 0) currentRequests[index] = updated;
}

function confirmDiscardEdits() {
    if (!document.querySelector(".edit-panel:not([hidden])")) return true;
    return confirm("You have an edit open that is not saved. Continue and discard it?");
}

/* =========================================================
   PDF HELPERS
   ========================================================= */

function validatePdf(file) {
    if (!file.name.toLowerCase().endsWith(".pdf")) return "Please choose a PDF file.";
    if (file.size > MAX_PDF_SIZE) return "The PDF must be 10 MB or smaller.";
    if (file.size === 0) return "That file is empty.";
    return "";
}

async function openPdf(id, kind, download) {
    // Open the tab first so the browser does not block it as a pop-up.
    const viewer = download ? null : window.open("", "_blank");

    try {
        const response = await fetch(`${API}/certificates/${id}/documents/${kind}`, {
            credentials: "same-origin"
        });

        if (!response.ok) {
            let message = "The PDF is not available.";
            try {
                const data = await response.json();
                message = data.message || message;
            } catch (error) { /* keep the default message */ }
            throw new Error(message);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);

        if (viewer) {
            viewer.location = url;
        } else {
            const link = document.createElement("a");
            link.href = url;
            link.download = `${kind}-certificate-${id}.pdf`;
            document.body.appendChild(link);
            link.click();
            link.remove();
        }

        setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
        if (viewer) viewer.close();
        showToast(error.message, "error");
    }
}

function pdfControls(request, kind) {
    const name = kind === "supporting" ? request.supportingFile : request.issuedFile;
    if (!name) return "";
    return `
        <div class="file-line">
            <span>📄 ${escapeHTML(name)}</span>
            <button class="btn btn-outline btn-small" data-action="view-pdf"
                data-id="${escapeHTML(request.id)}" data-kind="${kind}">View</button>
            <button class="btn btn-outline btn-small" data-action="download-pdf"
                data-id="${escapeHTML(request.id)}" data-kind="${kind}">Download</button>
        </div>
    `;
}

function uploadControl(request, kind, buttonText) {
    return `
        <div class="upload-row">
            <input type="file" accept="application/pdf,.pdf" id="${kind}-file-${escapeHTML(request.id)}">
            <button class="btn btn-primary btn-small" data-action="upload-${kind}"
                data-id="${escapeHTML(request.id)}">${escapeHTML(buttonText)}</button>
        </div>
    `;
}

async function handleDocumentUpload(requestId, kind) {
    if (busy) return;

    const input = document.getElementById(`${kind}-file-${requestId}`);
    const file = input && input.files[0];

    if (!file) {
        showToast("Choose a PDF file first.", "error");
        return;
    }

    const problem = validatePdf(file);
    if (problem) {
        showToast(problem, "error");
        return;
    }

    busy = true;
    try {
        const form = new FormData();
        form.append("file", file);

        const updated = await apiRequest(`/certificates/${requestId}/documents/${kind}`, {
            method: "POST",
            body: form
        });

        replaceRequest(updated);
        showToast("PDF uploaded successfully.");

        if (currentRole === "STUDENT") {
            renderStudentDashboard();
        } else {
            refreshOfficeCard(updated);
        }
    } catch (error) {
        showToast(error.message, "error");
    } finally {
        busy = false;
    }
}

/* =========================================================
   HEADER
   ========================================================= */

function updateHeader() {
    if (!headerActions) return;

    if (!currentUser) {
        headerActions.innerHTML = "";
        return;
    }

    const displayName = currentUser.studentName || currentUser.username || currentRole;

    headerActions.innerHTML = `
        <div class="header-user">
            <span>Welcome, ${escapeHTML(displayName)}</span>
            <button class="btn btn-outline btn-small" id="logout-button">↪ Logout</button>
        </div>
    `;
}

/* =========================================================
   LANDING PAGE
   ========================================================= */

function renderLandingPage() {
    currentUser = null;
    currentRole = null;
    updateHeader();

    app.innerHTML = `
        <section class="landing-page">
            <div class="hero-section">
                <span class="eyebrow">SMART CAMPUS SOLUTION</span>
                <h2>Welcome to Smart Campus Hub</h2>
                <p>A simple and transparent way to request, manage, and track your college certificates.</p>
            </div>

            <h3 class="section-heading">Choose Your Portal</h3>

            <div class="role-grid">

                <div class="role-card">
                    <div class="role-icon">🎓</div>
                    <h3>Student Portal</h3>
                    <p>Register, request certificates, and track your request progress.</p>
                    <button class="btn btn-primary" data-role="STUDENT">Student Login</button>
                    <button class="text-button" id="register-link">New student? Create an account</button>
                </div>

                <div class="role-card">
                    <div class="role-icon">🏢</div>
                    <h3>Office Portal</h3>
                    <p>Manage certificate requests department-wise and update their status.</p>
                    <button class="btn btn-primary" data-role="OFFICE">Office Login</button>
                </div>

                <div class="role-card">
                    <div class="role-icon">🛡️</div>
                    <h3>Administrator Portal</h3>
                    <p>View student details, certificate requests, and overall statistics.</p>
                    <button class="btn btn-primary" data-role="ADMIN">Administrator Login</button>
                </div>

            </div>
        </section>
    `;
}

/* =========================================================
   LOGIN
   ========================================================= */

function renderLoginPage(role) {
    currentRole = role;

    const roleName = { STUDENT: "Student", OFFICE: "Office", ADMIN: "Administrator" }[role] || role;

    app.innerHTML = `
        <section class="auth-wrapper">
            <div class="auth-card">

                <button class="back-button" id="back-home">← Back</button>

                <div class="auth-icon">🔐</div>
                <h2>${roleName} Login</h2>
                <p class="muted">Enter your login credentials to continue.</p>

                <form id="login-form">
                    <label for="login-username">Username</label>
                    <input type="text" id="login-username" name="username"
                        placeholder="Enter username" required autocomplete="username">

                    <label for="login-password">Password</label>
                    <input type="password" id="login-password" name="password"
                        placeholder="Enter password" required autocomplete="current-password">

                    <button type="submit" class="btn btn-primary btn-full" id="login-submit">Login</button>
                </form>

                ${role === "STUDENT"
                    ? `<button class="text-button" id="register-link">New student? Create an account</button>`
                    : ""}

            </div>
        </section>
    `;
}

async function handleLogin(event) {
    event.preventDefault();
    if (busy) return;

    const form = event.target;
    const submitButton = document.getElementById("login-submit");
    const username = form.username.value.trim();
    const password = form.password.value;

    if (!username || !password) {
        showToast("Please enter your username and password.", "error");
        return;
    }

    busy = true;
    submitButton.disabled = true;
    submitButton.textContent = "Logging in...";

    try {
        await apiRequest("/login", {
            method: "POST",
            body: { role: currentRole, username, password }
        });

        currentUser = await apiRequest("/me");

        if (!currentUser || !currentUser.role) {
            throw new Error("Unable to retrieve your login session.");
        }

        currentRole = String(currentUser.role).toUpperCase();
        updateHeader();
        showToast("Login successful!");
        busy = false;

        await openDashboard();
    } catch (error) {
        busy = false;
        showToast(error.message, "error");
        submitButton.disabled = false;
        submitButton.textContent = "Login";
    }
}

async function openDashboard() {
    if (currentRole === "STUDENT") {
        await loadStudentDashboard();
    } else if (currentRole === "OFFICE") {
        await loadOfficeDashboard();
    } else if (currentRole === "ADMIN") {
        await loadAdminDashboard();
    } else {
        renderLandingPage();
    }
}

/* =========================================================
   STUDENT REGISTRATION
   ========================================================= */

function renderRegistrationPage() {
    app.innerHTML = `
        <section class="auth-wrapper">
            <div class="auth-card registration-card">

                <button class="back-button" id="back-home">← Back</button>

                <div class="auth-icon">🎓</div>
                <h2>Student Registration</h2>
                <p class="muted">Create your Smart Campus Hub student account.</p>

                <form id="registration-form">

                    <label for="student-name">Full Name</label>
                    <input id="student-name" name="studentName" type="text"
                        placeholder="Enter your full name" maxlength="100" required>

                    <label for="student-usn">USN</label>
                    <input id="student-usn" name="usn" type="text"
                        placeholder="Enter your USN" maxlength="20" required>

                    <label for="student-department">Department</label>
                    <select id="student-department" name="department" required>
                        <option value="">Select department</option>
                        ${DEPARTMENTS.map(d => `<option value="${escapeHTML(d)}">${escapeHTML(d)}</option>`).join("")}
                    </select>

                    <label for="register-username">Username</label>
                    <input id="register-username" name="username" type="text"
                        placeholder="Create a username (3-30 characters)" maxlength="30"
                        required autocomplete="username">

                    <label for="register-password">Password</label>
                    <input id="register-password" name="password" type="password"
                        placeholder="Create a password (at least 6 characters)"
                        minlength="6" required autocomplete="new-password">

                    <button type="submit" class="btn btn-primary btn-full" id="register-submit">
                        Create Account
                    </button>

                </form>

                <button class="text-button" id="student-login-link">Already registered? Login</button>

            </div>
        </section>
    `;
}

async function handleRegistration(event) {
    event.preventDefault();
    if (busy) return;

    const form = event.target;
    const button = document.getElementById("register-submit");

    const studentName = form.studentName.value.trim();
    const usn = form.usn.value.trim().toUpperCase();
    const department = form.department.value;
    const username = form.username.value.trim();
    const password = form.password.value;

    if (!studentName || !usn || !department || !username || !password) {
        showToast("Please fill in all the fields.", "error");
        return;
    }
    if (password.length < 6) {
        showToast("Password must be at least 6 characters.", "error");
        return;
    }

    busy = true;
    button.disabled = true;
    button.textContent = "Creating account...";

    try {
        await apiRequest("/register", {
            method: "POST",
            body: { studentName, usn, department, username, password }
        });

        showToast("Registration successful! Please log in.");
        busy = false;
        renderLoginPage("STUDENT");
    } catch (error) {
        busy = false;
        showToast(error.message, "error");
        button.disabled = false;
        button.textContent = "Create Account";
    }
}

/* =========================================================
   HISTORY AND REPORTED ISSUES (shared by all portals)
   ========================================================= */

function renderHistory(request) {
    const history = Array.isArray(request.history) ? request.history : [];
    const issues = Array.isArray(request.issues) ? request.issues : [];

    const issueHtml = issues.length
        ? `<div class="issue-list">
               <h4>Reported Issues</h4>
               ${issues.map(item => `
                   <div class="issue-item">
                       <p>${escapeHTML(item.message)}</p>
                       <small>${formatDate(item.time)}</small>
                   </div>
               `).join("")}
           </div>`
        : "";

    if (!history.length) {
        return `<div class="history-empty">No history is available for this request yet.</div>${issueHtml}`;
    }

    return `
        <div class="history-timeline">
            ${history.map(item => `
                <div class="history-item">
                    <div class="history-dot"></div>
                    <div class="history-content">
                        <div class="history-heading">
                            ${statusBadge(item.status)}
                            <span>${formatDate(item.time)}</span>
                        </div>
                        <p>${escapeHTML(item.note || "Status updated.")}</p>
                        <small>Updated by: ${escapeHTML(item.actor || "System")}</small>
                    </div>
                </div>
            `).join("")}
        </div>
        ${issueHtml}
    `;
}

function toggleHistory(requestId) {
    const container = document.getElementById(`history-${requestId}`);
    if (!container) return;

    if (!container.hidden) {
        container.hidden = true;
        container.innerHTML = "";
        return;
    }

    const request = currentRequests.find(item => String(item.id) === String(requestId));
    if (!request) {
        showToast("Request not found. Please refresh.", "error");
        return;
    }

    container.innerHTML = renderHistory(request);
    container.hidden = false;
}

/* =========================================================
   STUDENT DASHBOARD
   ========================================================= */

async function loadStudentDashboard() {
    setLoading("Loading your requests...");
    try {
        currentRequests = await apiRequest("/certificates");
        renderStudentDashboard();
    } catch (error) {
        showToast(error.message, "error");
        renderLandingPage();
    }
}

function renderStudentDashboard() {
    const requests = currentRequests || [];
    const stats = summarize(requests);

    app.innerHTML = `
        <section class="dashboard">

            <div class="dashboard-heading">
                <div>
                    <span class="eyebrow">STUDENT PORTAL</span>
                    <h2>Hello, ${escapeHTML(currentUser?.studentName || "Student")} 👋</h2>
                    <p>Track your certificate requests here.</p>
                </div>
                <button class="btn btn-primary" id="show-request-form">+ New Certificate Request</button>
            </div>

            <div class="stats-grid">
                ${statCard("📄", "Total Requests", stats.total)}
                ${statCard("⏳", "In Progress", stats.pending)}
                ${statCard("⚠️", "Delayed", stats.delayed)}
                ${statCard("✅", "Ready / Collected", stats.completed)}
                ${statCard("❌", "Rejected", stats.rejected)}
            </div>

            <section id="student-request-area"></section>

            <section class="content-card">
                <div class="section-header">
                    <div>
                        <h3>My Certificate Requests</h3>
                        <p>View the latest status of your requests.</p>
                    </div>
                    <button class="btn btn-outline btn-small" id="student-refresh">↻ Refresh</button>
                </div>

                ${requests.length
                    ? `<div class="request-grid">${requests.map(renderStudentRequest).join("")}</div>`
                    : emptyMessage("You haven't submitted any requests yet.")}
            </section>

        </section>
    `;
}

function renderStudentRequest(request) {
    const id = escapeHTML(request.id);
    const closed = CLOSED_STATUSES.includes(request.status);

    return `
        <article class="request-card">

            <div class="request-card-top">
                <h3>${escapeHTML(request.certificateType)}</h3>
                ${statusBadge(request.status)}
            </div>

            <p class="request-purpose">${escapeHTML(request.purpose)}</p>

            <div class="request-details">
                <div><span>Request ID</span><strong>#${id}</strong></div>
                <div><span>Submitted</span><strong>${formatDate(request.submittedAt)}</strong></div>
                <div><span>Expected Date</span><strong>${formatDateOnly(request.expectedDate)}</strong></div>
                <div><span>Department</span><strong>${escapeHTML(request.department)}</strong></div>
            </div>

            ${request.status === "Need Documents"
                ? `<div class="notice-box"><strong>Action needed:</strong>
                   <p>The office needs more documents. Upload a PDF below.</p></div>`
                : ""}

            ${request.delayReason
                ? `<div class="notice-box"><strong>Delay Reason:</strong>
                   <p>${escapeHTML(request.delayReason)}</p></div>`
                : ""}

            ${request.officeRemarks
                ? `<div class="notice-box"><strong>Office Remarks:</strong>
                   <p>${escapeHTML(request.officeRemarks)}</p></div>`
                : ""}

            <div class="file-section">
                <strong>Supporting Document</strong>
                ${request.supportingFile
                    ? pdfControls(request, "supporting")
                    : `<p class="muted">No supporting PDF uploaded.</p>`}
                ${closed ? "" : uploadControl(request, "supporting",
                    request.supportingFile ? "Replace PDF" : "Upload PDF")}
            </div>

            <div class="file-section">
                <strong>Issued Certificate</strong>
                ${request.issuedFile
                    ? `<p class="success-text">Your certificate is ready to download.</p>${pdfControls(request, "issued")}`
                    : `<p class="muted">Not uploaded by the office yet.</p>`}
            </div>

            <div class="office-card-actions">
                <button class="btn btn-outline btn-small" data-action="student-history" data-id="${id}">
                    🕘 View History
                </button>
                <button class="btn btn-outline btn-small" data-action="toggle-issue" data-id="${id}">
                    ⚠️ Report Issue
                </button>
            </div>

            <form class="issue-form" id="issue-form-${id}" data-id="${id}" hidden>
                <label>Describe the problem</label>
                <textarea name="message" rows="3" maxlength="1000"
                    placeholder="Tell the office what is wrong..." required></textarea>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-small">Send Report</button>
                    <button type="button" class="btn btn-outline btn-small"
                        data-action="toggle-issue" data-id="${id}">Cancel</button>
                </div>
            </form>

            <div class="history-container" id="history-${id}" hidden></div>

        </article>
    `;
}

function renderStudentRequestForm() {
    const area = document.getElementById("student-request-area");
    if (!area) return;

    area.innerHTML = `
        <section class="content-card form-card">

            <div class="section-header">
                <div>
                    <h3>New Certificate Request</h3>
                    <p>Enter the details of the certificate you need.</p>
                </div>
                <button class="icon-button" id="close-request-form" title="Close">✕</button>
            </div>

            <form id="certificate-form">

                <label for="certificate-type">Certificate Type</label>
                <select id="certificate-type" name="certificateType" required>
                    <option value="">Select certificate type</option>
                    ${CERTIFICATE_TYPES.map(t => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`).join("")}
                </select>

                <label for="certificate-purpose">Purpose</label>
                <textarea id="certificate-purpose" name="purpose" rows="4" maxlength="1000"
                    placeholder="Explain why you need this certificate..." required></textarea>

                <label for="expected-date">Required By</label>
                <input type="date" id="expected-date" name="expectedDate" min="${todayString()}" required>

                <label for="supporting-pdf">Supporting PDF (optional)</label>
                <input type="file" id="supporting-pdf" name="supportingPdf" accept="application/pdf,.pdf">
                <small class="muted">PDF only, maximum 10 MB.</small>

                <div class="form-actions">
                    <button type="submit" class="btn btn-primary" id="submit-certificate">Submit Request</button>
                    <button type="button" class="btn btn-outline" id="cancel-request">Cancel</button>
                </div>

            </form>

        </section>
    `;
}

async function handleCertificateSubmission(event) {
    event.preventDefault();
    if (busy) return; // prevents duplicate submissions

    const form = event.target;
    const button = document.getElementById("submit-certificate");

    const certificateType = form.certificateType.value;
    const purpose = form.purpose.value.trim();
    const expectedDate = form.expectedDate.value;
    const file = form.supportingPdf.files[0];

    if (!certificateType || !purpose || !expectedDate) {
        showToast("Please complete all request details.", "error");
        return;
    }

    if (file) {
        const problem = validatePdf(file);
        if (problem) {
            showToast(problem, "error");
            return;
        }
    }

    busy = true;
    button.disabled = true;
    button.textContent = "Submitting...";

    try {
        const created = await apiRequest("/certificates", {
            method: "POST",
            body: { certificateType, purpose, expectedDate }
        });

        let uploadMessage = "";

        if (file) {
            try {
                const data = new FormData();
                data.append("file", file);
                await apiRequest(`/certificates/${created.id}/documents/supporting`, {
                    method: "POST",
                    body: data
                });
            } catch (uploadError) {
                uploadMessage = ` The PDF could not be uploaded (${uploadError.message}). You can upload it from the request card.`;
            }
        }

        showToast("Certificate request submitted." + uploadMessage, uploadMessage ? "error" : "success");
        busy = false;
        await loadStudentDashboard();
    } catch (error) {
        busy = false;
        showToast(error.message, "error");
        button.disabled = false;
        button.textContent = "Submit Request";
    }
}

async function handleIssueSubmit(event) {
    event.preventDefault();
    if (busy) return;

    const form = event.target;
    const requestId = form.dataset.id;
    const message = form.message.value.trim();
    const button = form.querySelector('button[type="submit"]');

    if (!message) {
        showToast("Please describe the problem.", "error");
        return;
    }

    busy = true;
    button.disabled = true;

    try {
        const updated = await apiRequest(`/certificates/${requestId}/issues`, {
            method: "POST",
            body: { message }
        });
        replaceRequest(updated);
        showToast("Your issue has been sent to the office.");
        renderStudentDashboard();
    } catch (error) {
        showToast(error.message, "error");
        button.disabled = false;
    } finally {
        busy = false;
    }
}

/* =========================================================
   OFFICE DASHBOARD
   ========================================================= */

async function loadOfficeDashboard() {
    currentRole = "OFFICE";
    setLoading("Loading office portal...");

    try {
        await loadOfficeRequests();
        renderOfficeDashboard();
    } catch (error) {
        showToast(error.message, "error");
        renderLandingPage();
    }
}

async function loadOfficeRequests() {
    currentRequests = await apiRequest(`/certificates?department=${encodeURIComponent(selectedDepartment)}`);
}

function officeStatsHtml(requests) {
    const stats = summarize(requests);
    return `
        ${statCard("📄", "Total Requests", stats.total)}
        ${statCard("⏳", "In Progress", stats.pending)}
        ${statCard("⚠️", "Delayed", stats.delayed)}
        ${statCard("✅", "Ready / Collected", stats.completed)}
        ${statCard("❌", "Rejected", stats.rejected)}
    `;
}

function renderOfficeDashboard() {
    const requests = currentRequests || [];

    app.innerHTML = `
        <section class="dashboard">

            <div class="dashboard-heading">
                <div>
                    <span class="eyebrow">OFFICE PORTAL</span>
                    <h2>Certificate Management</h2>
                    <p>Manage requests for each college department.</p>
                </div>
                <button class="btn btn-outline" id="office-refresh">↻ Refresh Requests</button>
            </div>

            <section class="content-card department-section">
                <h3>Select Department</h3>
                <div class="department-tabs">
                    ${DEPARTMENTS.map(d => `
                        <button class="department-tab ${selectedDepartment === d ? "active" : ""}"
                            data-department="${escapeHTML(d)}">${escapeHTML(d)}</button>
                    `).join("")}
                </div>
            </section>

            <div class="stats-grid" id="office-stats">${officeStatsHtml(requests)}</div>

            <section class="content-card">

                <div class="section-header">
                    <div>
                        <h3>${escapeHTML(selectedDepartment)} Requests</h3>
                        <p>Review and update certificate requests. The list only refreshes when you ask it to.</p>
                    </div>
                </div>

                <div class="filter-row">
                    <input type="search" id="office-search"
                        placeholder="Search by student name, USN or certificate...">

                    <select id="office-status-filter">
                        <option value="">All Statuses</option>
                        ${STATUSES.map(s => `<option value="${escapeHTML(s)}">${escapeHTML(s)}</option>`).join("")}
                    </select>
                </div>

                <div id="office-request-list">${renderOfficeRequestList(requests)}</div>
                <p class="muted hidden" id="office-no-match">No requests match your search.</p>

            </section>

        </section>
    `;
}

function renderOfficeRequestList(requests) {
    if (!requests.length) {
        return emptyMessage(`No certificate requests found for ${selectedDepartment}.`);
    }
    return `<div class="request-grid">${requests.map(renderOfficeRequestCard).join("")}</div>`;
}

function renderOfficeRequestCard(request) {
    const id = escapeHTML(request.id);
    const searchText = [request.studentName, request.usn, request.certificateType, request.purpose]
        .join(" ").toLowerCase();

    return `
        <article class="request-card office-card" id="office-card-${id}"
            data-search="${escapeHTML(searchText)}" data-status="${escapeHTML(request.status)}">

            <div class="request-card-top">
                <h3>${escapeHTML(request.certificateType)}</h3>
                ${statusBadge(request.status)}
            </div>

            <div class="student-info">
                <strong>${escapeHTML(request.studentName)}</strong>
                <span>${escapeHTML(request.usn)}</span>
            </div>

            <p class="request-purpose">${escapeHTML(request.purpose)}</p>

            <div class="request-details">
                <div><span>Request ID</span><strong>#${id}</strong></div>
                <div><span>Submitted</span><strong>${formatDate(request.submittedAt)}</strong></div>
                <div><span>Expected Date</span><strong>${formatDateOnly(request.expectedDate)}</strong></div>
                <div><span>Department</span><strong>${escapeHTML(request.department)}</strong></div>
            </div>

            ${request.delayReason
                ? `<div class="notice-box"><strong>Delay Reason:</strong>
                   <p>${escapeHTML(request.delayReason)}</p></div>`
                : ""}

            ${request.officeRemarks
                ? `<div class="notice-box"><strong>Office Remarks:</strong>
                   <p>${escapeHTML(request.officeRemarks)}</p></div>`
                : ""}

            ${Array.isArray(request.issues) && request.issues.length
                ? `<div class="notice-box issue-notice"><strong>⚠️ ${request.issues.length} issue(s) reported by the student.</strong>
                   <p>Open View History to read them.</p></div>`
                : ""}

            <div class="file-section">
                <strong>Student's Supporting PDF</strong>
                ${request.supportingFile
                    ? pdfControls(request, "supporting")
                    : `<p class="muted">No supporting PDF uploaded.</p>`}
            </div>

            <div class="file-section">
                <strong>Issued Certificate PDF</strong>
                ${request.issuedFile ? pdfControls(request, "issued") : `<p class="muted">Not uploaded yet.</p>`}
                ${uploadControl(request, "issued", request.issuedFile ? "Replace Certificate" : "Upload Certificate")}
            </div>

            <div class="office-card-actions">
                <button class="btn btn-primary btn-small" data-action="edit-request" data-id="${id}">
                    ✏️ Edit Status
                </button>
                <button class="btn btn-outline btn-small" data-action="office-history" data-id="${id}">
                    🕘 View History
                </button>
            </div>

            <div class="edit-panel" id="edit-${id}" hidden></div>
            <div class="history-container" id="history-${id}" hidden></div>

        </article>
    `;
}

/** Redraws one card only, so other open edit forms are not disturbed. */
function refreshOfficeCard(request) {
    const card = document.getElementById(`office-card-${request.id}`);
    if (card) card.outerHTML = renderOfficeRequestCard(request);

    const stats = document.getElementById("office-stats");
    if (stats) stats.innerHTML = officeStatsHtml(currentRequests);

    applyOfficeFilters();
}

/** Search and status filter only hide or show cards. Nothing is redrawn. */
function applyOfficeFilters() {
    const search = (document.getElementById("office-search")?.value || "").trim().toLowerCase();
    const status = document.getElementById("office-status-filter")?.value || "";

    let visible = 0;
    document.querySelectorAll(".office-card").forEach(card => {
        const matches = card.dataset.search.includes(search)
            && (!status || card.dataset.status === status);
        card.hidden = !matches;
        if (matches) visible++;
    });

    const message = document.getElementById("office-no-match");
    if (message) {
        const hasCards = document.querySelectorAll(".office-card").length > 0;
        message.classList.toggle("hidden", !(hasCards && visible === 0));
    }
}

function openEditPanel(requestId) {
    const container = document.getElementById(`edit-${requestId}`);
    if (!container) return;

    if (!container.hidden) {
        container.hidden = true;
        container.innerHTML = "";
        return;
    }

    const request = currentRequests.find(item => String(item.id) === String(requestId));
    if (!request) {
        showToast("Request not found.", "error");
        return;
    }

    container.innerHTML = `
        <div class="edit-panel-inner">

            <h3>✏️ Edit Certificate Request</h3>

            <form class="office-edit-form" data-id="${escapeHTML(requestId)}">

                <label>Status</label>
                <select name="status" class="status-select" required>
                    ${STATUSES.map(s => `
                        <option value="${escapeHTML(s)}" ${request.status === s ? "selected" : ""}>
                            ${escapeHTML(s)}
                        </option>
                    `).join("")}
                </select>

                <label>Expected Completion Date</label>
                <input type="date" name="expectedDate" value="${escapeHTML(request.expectedDate || "")}">

                <div class="delay-field ${request.status === "Delayed" ? "" : "hidden"}">
                    <label>Delay Reason (required when Delayed)</label>
                    <textarea name="delayReason" rows="3" maxlength="500"
                        placeholder="Enter the reason for the delay...">${escapeHTML(request.delayReason || "")}</textarea>
                </div>

                <label>Office Remarks</label>
                <textarea name="officeRemarks" rows="3" maxlength="1000"
                    placeholder="Enter remarks for the student...">${escapeHTML(request.officeRemarks || "")}</textarea>

                <div class="form-actions">
                    <button type="submit" class="btn btn-primary">💾 Save Changes</button>
                    <button type="button" class="btn btn-outline" data-action="close-edit"
                        data-id="${escapeHTML(requestId)}">Cancel</button>
                </div>

            </form>

        </div>
    `;

    container.hidden = false;
}

async function handleOfficeUpdate(event) {
    event.preventDefault();
    if (busy) return;

    const form = event.target;
    const requestId = form.dataset.id;
    const submitButton = form.querySelector('button[type="submit"]');

    const status = form.status.value;
    const expectedDate = form.expectedDate.value;
    const delayReason = form.delayReason.value.trim();
    const officeRemarks = form.officeRemarks.value.trim();

    if (status === "Delayed" && !delayReason) {
        showToast("Please enter the reason for the delay.", "error");
        return;
    }

    busy = true;
    submitButton.disabled = true;
    submitButton.textContent = "Saving...";

    try {
        const updated = await apiRequest(`/certificates/${requestId}`, {
            method: "PATCH",
            body: {
                department: selectedDepartment,
                status,
                expectedDate,
                delayReason: status === "Delayed" ? delayReason : "",
                officeRemarks
            }
        });

        replaceRequest(updated);
        refreshOfficeCard(updated);
        showToast("Certificate request updated successfully!");
    } catch (error) {
        showToast(error.message, "error");
        submitButton.disabled = false;
        submitButton.textContent = "💾 Save Changes";
    } finally {
        busy = false;
    }
}

/* =========================================================
   ADMIN DASHBOARD
   ========================================================= */

async function loadAdminDashboard() {
    currentRole = "ADMIN";
    setLoading("Loading administrator dashboard...");

    try {
        const results = await Promise.all([
            apiRequest("/admin/summary"),
            apiRequest("/certificates"),
            apiRequest("/admin/students")
        ]);

        currentSummary = results[0] || {};
        currentRequests = results[1] || [];
        currentStudents = results[2] || [];

        renderAdminDashboard();
    } catch (error) {
        showToast(error.message, "error");
        renderLandingPage();
    }
}

function renderAdminDashboard() {
    const summary = currentSummary || {};
    const requests = currentRequests || [];
    const students = currentStudents || [];
    const byDepartment = Array.isArray(summary.byDepartment) ? summary.byDepartment : [];

    app.innerHTML = `
        <section class="dashboard">

            <div class="dashboard-heading">
                <div>
                    <span class="eyebrow">ADMINISTRATOR PORTAL</span>
                    <h2>Admin Dashboard</h2>
                    <p>Overview of students and certificate requests.</p>
                </div>
                <button class="btn btn-outline" id="admin-refresh">↻ Refresh Dashboard</button>
            </div>

            <div class="stats-grid">
                ${statCard("📄", "Total Requests", Number(summary.total ?? requests.length))}
                ${statCard("👨‍🎓", "Registered Students", Number(summary.registeredStudents ?? students.length))}
                ${statCard("⏳", "Pending", Number(summary.pending ?? 0))}
                ${statCard("⚠️", "Delayed", Number(summary.delayed ?? 0))}
                ${statCard("✅", "Completed", Number(summary.completed ?? 0))}
                ${statCard("❌", "Rejected", Number(summary.rejected ?? 0))}
                ${statCard("📅", "Overdue", Number(summary.overdue ?? 0))}
            </div>

            <section class="content-card">
                <div class="section-header">
                    <div>
                        <h3>Department-wise Overview</h3>
                        <p>Progress of certificate requests in each department.</p>
                    </div>
                </div>

                <div class="table-wrapper">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Department</th><th>Total</th><th>Pending</th>
                                <th>Delayed</th><th>Completed</th><th>Rejected</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${byDepartment.length
                                ? byDepartment.map(d => `
                                    <tr>
                                        <td><strong>${escapeHTML(d.department)}</strong></td>
                                        <td>${Number(d.total)}</td>
                                        <td>${Number(d.pending)}</td>
                                        <td>${Number(d.delayed)}</td>
                                        <td>${Number(d.completed)}</td>
                                        <td>${Number(d.rejected)}</td>
                                    </tr>`).join("")
                                : `<tr><td colspan="6">No data available.</td></tr>`}
                        </tbody>
                    </table>
                </div>
            </section>

            <section class="content-card">

                <div class="section-header">
                    <div>
                        <h3>All Certificate Requests</h3>
                        <p>View every request submitted by students.</p>
                    </div>
                </div>

                <div class="filter-row">
                    <input type="search" id="admin-request-search"
                        placeholder="Search student, USN, certificate...">

                    <select id="admin-department-filter">
                        <option value="">All Departments</option>
                        ${DEPARTMENTS.map(d => `<option value="${escapeHTML(d)}">${escapeHTML(d)}</option>`).join("")}
                    </select>

                    <select id="admin-status-filter">
                        <option value="">All Statuses</option>
                        ${STATUSES.map(s => `<option value="${escapeHTML(s)}">${escapeHTML(s)}</option>`).join("")}
                    </select>
                </div>

                <div class="table-wrapper">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>ID</th><th>Student</th><th>USN</th><th>Department</th>
                                <th>Certificate</th><th>Status</th><th>Expected Date</th>
                                <th>PDFs</th><th>History</th>
                            </tr>
                        </thead>
                        <tbody id="admin-request-table">${renderAdminRequestRows(requests)}</tbody>
                    </table>
                </div>

            </section>

            <section class="content-card">

                <div class="section-header">
                    <div>
                        <h3>Registered Students</h3>
                        <p>List of student accounts in Smart Campus Hub.</p>
                    </div>
                </div>

                <div class="filter-row">
                    <input type="search" id="admin-student-search"
                        placeholder="Search student name, USN or username...">
                </div>

                <div class="table-wrapper">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Name</th><th>USN</th><th>Department</th>
                                <th>Username</th><th>Requests</th><th>Registered On</th>
                            </tr>
                        </thead>
                        <tbody id="admin-student-table">${renderAdminStudentRows(students)}</tbody>
                    </table>
                </div>

            </section>

        </section>
    `;
}

function adminPdfButtons(request) {
    const buttons = [];
    if (request.supportingFile) {
        buttons.push(`<button class="btn btn-outline btn-small" data-action="view-pdf"
            data-id="${escapeHTML(request.id)}" data-kind="supporting">Student PDF</button>`);
    }
    if (request.issuedFile) {
        buttons.push(`<button class="btn btn-outline btn-small" data-action="view-pdf"
            data-id="${escapeHTML(request.id)}" data-kind="issued">Issued PDF</button>`);
    }
    return buttons.length ? buttons.join(" ") : "-";
}

function renderAdminRequestRows(requests) {
    if (!requests.length) {
        return `<tr><td colspan="9">No certificate requests found.</td></tr>`;
    }

    return requests.map(request => `
        <tr>
            <td>#${escapeHTML(request.id)}</td>
            <td>${escapeHTML(request.studentName)}</td>
            <td>${escapeHTML(request.usn)}</td>
            <td>${escapeHTML(request.department)}</td>
            <td>${escapeHTML(request.certificateType)}</td>
            <td>${statusBadge(request.status)}</td>
            <td>${formatDateOnly(request.expectedDate)}</td>
            <td>${adminPdfButtons(request)}</td>
            <td>
                <button class="btn btn-outline btn-small" data-action="admin-history"
                    data-id="${escapeHTML(request.id)}">View</button>
            </td>
        </tr>
        <tr class="admin-history-row" id="admin-history-${escapeHTML(request.id)}" hidden>
            <td colspan="9">${renderHistory(request)}</td>
        </tr>
    `).join("");
}

function renderAdminStudentRows(students) {
    if (!students.length) {
        return `<tr><td colspan="6">No registered students found.</td></tr>`;
    }

    return students.map(student => `
        <tr>
            <td>${escapeHTML(student.studentName)}</td>
            <td>${escapeHTML(student.usn)}</td>
            <td>${escapeHTML(student.department)}</td>
            <td>${escapeHTML(student.username)}</td>
            <td>${Number(student.requestCount ?? 0)}</td>
            <td>${formatDate(student.createdAt)}</td>
        </tr>
    `).join("");
}

function filterAdminRequests() {
    const search = (document.getElementById("admin-request-search")?.value || "").toLowerCase();
    const department = document.getElementById("admin-department-filter")?.value || "";
    const status = document.getElementById("admin-status-filter")?.value || "";

    const filtered = currentRequests.filter(request => {
        const matchesSearch = [request.studentName, request.usn, request.certificateType, request.purpose]
            .some(value => String(value || "").toLowerCase().includes(search));
        return matchesSearch
            && (!department || request.department === department)
            && (!status || request.status === status);
    });

    const table = document.getElementById("admin-request-table");
    if (table) table.innerHTML = renderAdminRequestRows(filtered);
}

function filterAdminStudents() {
    const search = (document.getElementById("admin-student-search")?.value || "").toLowerCase();

    const filtered = currentStudents.filter(student =>
        [student.studentName, student.usn, student.username, student.department]
            .some(value => String(value || "").toLowerCase().includes(search))
    );

    const table = document.getElementById("admin-student-table");
    if (table) table.innerHTML = renderAdminStudentRows(filtered);
}

/* =========================================================
   LOGOUT
   ========================================================= */

async function handleLogout() {
    try {
        await apiRequest("/logout", { method: "POST" });
    } catch (error) {
        // Go back to the landing page even if the session already expired.
    }

    currentUser = null;
    currentRole = null;
    currentRequests = [];
    currentStudents = [];
    currentSummary = {};

    renderLandingPage();
    showToast("You have been logged out.");
}

/* =========================================================
   EVENT HANDLING (event delegation)
   ========================================================= */

document.addEventListener("click", async event => {
    const target = event.target;

    const roleButton = target.closest("[data-role]");
    if (roleButton) {
        renderLoginPage(roleButton.dataset.role);
        return;
    }

    if (target.closest("#back-home")) { renderLandingPage(); return; }
    if (target.closest("#register-link")) { renderRegistrationPage(); return; }
    if (target.closest("#student-login-link")) { renderLoginPage("STUDENT"); return; }
    if (target.closest("#logout-button")) { await handleLogout(); return; }

    if (target.closest("#show-request-form")) { renderStudentRequestForm(); return; }

    if (target.closest("#close-request-form") || target.closest("#cancel-request")) {
        const area = document.getElementById("student-request-area");
        if (area) area.innerHTML = "";
        return;
    }

    if (target.closest("#student-refresh")) { await loadStudentDashboard(); return; }

    // Switch department (office)
    const departmentButton = target.closest("[data-department]");
    if (departmentButton) {
        if (!confirmDiscardEdits()) return;
        selectedDepartment = departmentButton.dataset.department;
        setLoading(`Loading ${selectedDepartment} requests...`);
        try {
            await loadOfficeRequests();
            renderOfficeDashboard();
        } catch (error) {
            showToast(error.message, "error");
        }
        return;
    }

    // Manual refresh (office) - never refreshes on its own
    if (target.closest("#office-refresh")) {
        if (!confirmDiscardEdits()) return;
        try {
            await loadOfficeRequests();
            renderOfficeDashboard();
            showToast("Requests refreshed.");
        } catch (error) {
            showToast(error.message, "error");
        }
        return;
    }

    if (target.closest("#admin-refresh")) {
        await loadAdminDashboard();
        showToast("Dashboard refreshed.");
        return;
    }

    const actionButton = target.closest("[data-action]");
    if (!actionButton) return;

    const action = actionButton.dataset.action;
    const requestId = actionButton.dataset.id;

    switch (action) {
        case "edit-request":
            openEditPanel(requestId);
            break;

        case "close-edit": {
            const panel = document.getElementById(`edit-${requestId}`);
            if (panel) {
                panel.hidden = true;
                panel.innerHTML = "";
            }
            break;
        }

        case "office-history":
        case "student-history":
            toggleHistory(requestId);
            break;

        case "admin-history": {
            const row = document.getElementById(`admin-history-${requestId}`);
            if (row) row.hidden = !row.hidden;
            break;
        }

        case "toggle-issue": {
            const form = document.getElementById(`issue-form-${requestId}`);
            if (form) form.hidden = !form.hidden;
            break;
        }

        case "view-pdf":
            await openPdf(requestId, actionButton.dataset.kind, false);
            break;

        case "download-pdf":
            await openPdf(requestId, actionButton.dataset.kind, true);
            break;

        case "upload-supporting":
            await handleDocumentUpload(requestId, "supporting");
            break;

        case "upload-issued":
            await handleDocumentUpload(requestId, "issued");
            break;

        default:
            break;
    }
});

document.addEventListener("submit", async event => {
    const form = event.target;

    if (form.id === "login-form") { await handleLogin(event); return; }
    if (form.id === "registration-form") { await handleRegistration(event); return; }
    if (form.id === "certificate-form") { await handleCertificateSubmission(event); return; }
    if (form.classList.contains("office-edit-form")) { await handleOfficeUpdate(event); return; }
    if (form.classList.contains("issue-form")) { await handleIssueSubmit(event); }
});

document.addEventListener("input", event => {
    if (event.target.id === "office-search") { applyOfficeFilters(); return; }
    if (event.target.id === "admin-request-search") { filterAdminRequests(); return; }
    if (event.target.id === "admin-student-search") { filterAdminStudents(); }
});

document.addEventListener("change", event => {
    const target = event.target;

    if (target.id === "office-status-filter") { applyOfficeFilters(); return; }

    if (target.id === "admin-department-filter" || target.id === "admin-status-filter") {
        filterAdminRequests();
        return;
    }

    // Show the delay reason box only when the status is "Delayed"
    if (target.classList.contains("status-select")) {
        const form = target.closest("form");
        const field = form ? form.querySelector(".delay-field") : null;
        if (field) field.classList.toggle("hidden", target.value !== "Delayed");
    }
});

/* =========================================================
   START APPLICATION
   ========================================================= */

async function startApplication() {
    setLoading("Starting Smart Campus Hub...");

    try {
        currentUser = await apiRequest("/me");

        if (!currentUser || !currentUser.role) {
            throw new Error("No active session.");
        }

        currentRole = String(currentUser.role).toUpperCase();
        updateHeader();
        await openDashboard();
    } catch (error) {
        currentUser = null;
        currentRole = null;
        updateHeader();
        renderLandingPage();
    }
}

startApplication();