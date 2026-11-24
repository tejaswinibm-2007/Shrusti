package com.campushub;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.core.io.FileSystemResource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Smart Campus Hub backend.
 *
 * All data is stored in an H2 file database (the "data" folder).
 * Uploaded PDFs are stored in the "uploads" folder.
 */
@SpringBootApplication
@RestController
@RequestMapping("/api")
public class CampusHubApplication {

    public static void main(String[] args) {
        SpringApplication.run(CampusHubApplication.class, args);
    }

    /* =========================================================
       SETTINGS
       ========================================================= */

    private static final List<String> DEPARTMENTS =
            List.of("CSE", "CSE AIML", "AI DS", "ISE", "ECE", "EEE");

    private static final List<String> STATUSES = List.of(
            "Submitted", "Under Verification", "Processing", "Awaiting Approval",
            "Delayed", "Need Documents", "Ready for Collection", "Collected", "Rejected");

    // Groups used by the admin dashboard
    private static final Set<String> PENDING_STATUSES = Set.of(
            "Submitted", "Under Verification", "Processing", "Awaiting Approval", "Need Documents");
    private static final Set<String> COMPLETED_STATUSES = Set.of("Ready for Collection", "Collected");
    private static final Set<String> CLOSED_STATUSES = Set.of("Ready for Collection", "Collected", "Rejected");

    private static final long MAX_PDF_BYTES = 10L * 1024 * 1024;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final String officeUsername;
    private final String officePassword;
    private final String adminUsername;
    private final String adminPassword;
    private final Path uploadDir;

    public CampusHubApplication(
            JdbcTemplate jdbc,
            TransactionTemplate tx,
            @Value("${campushub.office.username}") String officeUsername,
            @Value("${campushub.office.password}") String officePassword,
            @Value("${campushub.admin.username}") String adminUsername,
            @Value("${campushub.admin.password}") String adminPassword,
            @Value("${campushub.upload-dir:uploads}") String uploadDirName) throws IOException {

        this.jdbc = jdbc;
        this.tx = tx;
        this.officeUsername = officeUsername;
        this.officePassword = officePassword;
        this.adminUsername = adminUsername;
        this.adminPassword = adminPassword;
        this.uploadDir = Path.of(uploadDirName).toAbsolutePath().normalize();
        Files.createDirectories(this.uploadDir);
    }

    /* =========================================================
       SMALL HELPERS
       ========================================================= */

    private ResponseEntity<Map<String, Object>> error(HttpStatus status, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("message", message);
        return ResponseEntity.status(status).body(body);
    }

    private Map<String, Object> result(String message, Object data) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("message", message);
        body.put("data", data);
        return body;
    }

    private static String str(Map<String, String> body, String key) {
        String value = body.get(key);
        return value == null ? "" : value.trim();
    }

    private static String limit(String text, int max) {
        return text.length() <= max ? text : text.substring(0, max);
    }

    private static String key(String username) {
        return username.toLowerCase(Locale.ROOT);
    }

    private static boolean isDepartment(String department) {
        return DEPARTMENTS.contains(department);
    }

    private static boolean isKind(String kind) {
        return "supporting".equals(kind) || "issued".equals(kind);
    }

    private static boolean safeEquals(String a, String b) {
        return MessageDigest.isEqual(
                a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private static String role(HttpSession session) {
        return session == null ? null : (String) session.getAttribute("role");
    }

    private static String username(HttpSession session) {
        return session == null ? null : (String) session.getAttribute("username");
    }

    private static String studentKey(HttpSession session) {
        return session == null ? null : (String) session.getAttribute("studentKey");
    }

    private static boolean loggedIn(HttpSession session) {
        return role(session) != null;
    }

    /* =========================================================
       PASSWORDS (PBKDF2 hashing, no plain-text passwords stored)
       ========================================================= */

    private static byte[] pbkdf2(String password, byte[] salt) {
        try {
            PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, 120_000, 256);
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                    .generateSecret(spec).getEncoded();
        } catch (Exception e) {
            throw new IllegalStateException("Password hashing failed", e);
        }
    }

    private static String hashPassword(String password) {
        byte[] salt = new byte[16];
        RANDOM.nextBytes(salt);
        return Base64.getEncoder().encodeToString(salt) + ":"
                + Base64.getEncoder().encodeToString(pbkdf2(password, salt));
    }

    private static boolean passwordMatches(String password, String stored) {
        try {
            String[] parts = stored.split(":");
            if (parts.length != 2) return false;
            byte[] salt = Base64.getDecoder().decode(parts[0]);
            byte[] expected = Base64.getDecoder().decode(parts[1]);
            return MessageDigest.isEqual(expected, pbkdf2(password, salt));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /* =========================================================
       DATABASE HELPERS
       ========================================================= */

    private Map<String, Object> findStudent(String username) {
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT * FROM students WHERE username_key = ?",
                (rs, i) -> {
                    Map<String, Object> s = new LinkedHashMap<>();
                    s.put("studentName", rs.getString("student_name"));
                    s.put("usn", rs.getString("usn"));
                    s.put("department", rs.getString("department"));
                    s.put("username", rs.getString("username"));
                    s.put("passwordHash", rs.getString("password_hash"));
                    s.put("createdAt", rs.getString("created_at"));
                    return s;
                },
                key(username));
        return rows.isEmpty() ? null : rows.get(0);
    }

    private Map<String, Object> mapRequest(ResultSet rs) throws SQLException {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("id", rs.getLong("id"));
        r.put("student", rs.getString("student_username"));
        r.put("studentName", rs.getString("student_name"));
        r.put("usn", rs.getString("usn"));
        r.put("department", rs.getString("department"));
        r.put("certificateType", rs.getString("certificate_type"));
        r.put("purpose", rs.getString("purpose"));
        r.put("status", rs.getString("status"));
        r.put("submittedAt", rs.getString("submitted_at"));
        r.put("originalExpectedDate", rs.getString("original_expected_date"));
        r.put("expectedDate", rs.getString("expected_date"));
        r.put("delayReason", rs.getString("delay_reason"));
        r.put("officeRemarks", rs.getString("office_remarks"));
        r.put("supportingFile", rs.getString("supporting_name"));
        r.put("issuedFile", rs.getString("issued_name"));
        r.put("updatedAt", rs.getString("updated_at"));
        r.put("updatedBy", rs.getString("updated_by"));
        return r;
    }

    /** Adds the history list and the reported issues to each request. */
    private List<Map<String, Object>> attach(List<Map<String, Object>> list) {
        if (list.isEmpty()) return list;

        Map<Long, List<Map<String, Object>>> history = new HashMap<>();
        jdbc.query(
                "SELECT request_id, status, note, actor, event_time FROM history ORDER BY id DESC",
                (RowCallbackHandler) rs -> {
                    Map<String, Object> h = new LinkedHashMap<>();
                    h.put("status", rs.getString("status"));
                    h.put("note", rs.getString("note"));
                    h.put("actor", rs.getString("actor"));
                    h.put("time", rs.getString("event_time"));
                    history.computeIfAbsent(rs.getLong("request_id"), k -> new ArrayList<>()).add(h);
                });

        Map<Long, List<Map<String, Object>>> issues = new HashMap<>();
        jdbc.query(
                "SELECT request_id, message, created_at FROM issues ORDER BY id DESC",
                (RowCallbackHandler) rs -> {
                    Map<String, Object> i = new LinkedHashMap<>();
                    i.put("message", rs.getString("message"));
                    i.put("time", rs.getString("created_at"));
                    issues.computeIfAbsent(rs.getLong("request_id"), k -> new ArrayList<>()).add(i);
                });

        for (Map<String, Object> r : list) {
            Long id = (Long) r.get("id");
            r.put("history", history.getOrDefault(id, List.of()));
            r.put("issues", issues.getOrDefault(id, List.of()));
        }
        return list;
    }

    private Map<String, Object> findRequest(long id) {
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT * FROM requests WHERE id = ?", (rs, i) -> mapRequest(rs), id);
        if (rows.isEmpty()) return null;
        return attach(rows).get(0);
    }

    private void addHistory(long requestId, String status, String note, String actor) {
        jdbc.update(
                "INSERT INTO history(request_id, status, note, actor, event_time) VALUES (?,?,?,?,?)",
                requestId, status, limit(note, 1500), actor, LocalDateTime.now().toString());
    }

    /* =========================================================
       REGISTRATION, LOGIN, SESSION
       ========================================================= */

    @PostMapping("/register")
    public ResponseEntity<?> register(@RequestBody Map<String, String> body) {
        String name = str(body, "studentName");
        String usn = str(body, "usn").toUpperCase(Locale.ROOT);
        String department = str(body, "department");
        String user = str(body, "username");
        String password = body.get("password") == null ? "" : body.get("password");

        if (name.isBlank() || usn.isBlank() || department.isBlank()
                || user.isBlank() || password.isBlank()) {
            return error(HttpStatus.BAD_REQUEST, "Please fill in all the fields.");
        }
        if (name.length() > 100) {
            return error(HttpStatus.BAD_REQUEST, "Name must be 100 characters or fewer.");
        }
        if (!usn.matches("[A-Z0-9]{5,20}")) {
            return error(HttpStatus.BAD_REQUEST, "USN must be 5 to 20 letters or digits.");
        }
        if (!isDepartment(department)) {
            return error(HttpStatus.BAD_REQUEST, "Choose a valid department.");
        }
        if (!user.matches("[A-Za-z0-9_.-]{3,30}")) {
            return error(HttpStatus.BAD_REQUEST,
                    "Username must be 3 to 30 characters (letters, digits, _ . -).");
        }
        if (password.length() < 6 || password.length() > 100) {
            return error(HttpStatus.BAD_REQUEST, "Password must be at least 6 characters.");
        }

        Integer sameUser = jdbc.queryForObject(
                "SELECT COUNT(*) FROM students WHERE username_key = ?", Integer.class, key(user));
        if (sameUser != null && sameUser > 0) {
            return error(HttpStatus.CONFLICT, "That username is already taken.");
        }
        Integer sameUsn = jdbc.queryForObject(
                "SELECT COUNT(*) FROM students WHERE usn = ?", Integer.class, usn);
        if (sameUsn != null && sameUsn > 0) {
            return error(HttpStatus.CONFLICT, "That USN is already registered.");
        }

        try {
            jdbc.update(
                    "INSERT INTO students(student_name, usn, department, username, username_key, "
                            + "password_hash, created_at) VALUES (?,?,?,?,?,?,?)",
                    name, usn, department, user, key(user), hashPassword(password),
                    LocalDateTime.now().toString());
        } catch (DuplicateKeyException e) {
            return error(HttpStatus.CONFLICT, "That username or USN is already registered.");
        }

        Map<String, Object> student = new LinkedHashMap<>();
        student.put("studentName", name);
        student.put("usn", usn);
        student.put("department", department);
        student.put("username", user);

        return ResponseEntity.status(HttpStatus.CREATED)
                .body(result("Registration successful. You can now log in.", student));
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody Map<String, String> body, HttpServletRequest request) {
        String selectedRole = str(body, "role").toUpperCase(Locale.ROOT);
        String user = str(body, "username");
        String password = body.get("password") == null ? "" : body.get("password");

        Map<String, Object> student = null;
        boolean valid = false;

        switch (selectedRole) {
            case "STUDENT" -> {
                student = findStudent(user);
                valid = student != null
                        && passwordMatches(password, (String) student.get("passwordHash"));
            }
            case "OFFICE" -> valid = safeEquals(officeUsername, user)
                    && safeEquals(officePassword, password);
            case "ADMIN" -> valid = safeEquals(adminUsername, user)
                    && safeEquals(adminPassword, password);
            default -> valid = false;
        }

        if (!valid) {
            return error(HttpStatus.UNAUTHORIZED, "Incorrect role, username, or password.");
        }

        // Start a fresh session after login (prevents session fixation)
        HttpSession old = request.getSession(false);
        if (old != null) old.invalidate();

        HttpSession session = request.getSession(true);
        session.setAttribute("role", selectedRole);

        if ("STUDENT".equals(selectedRole)) {
            session.setAttribute("username", student.get("username"));
            session.setAttribute("studentKey", key((String) student.get("username")));
            session.setAttribute("studentName", student.get("studentName"));
            session.setAttribute("usn", student.get("usn"));
            session.setAttribute("department", student.get("department"));
        } else {
            session.setAttribute("username", user);
        }

        return ResponseEntity.ok(result("Login successful", sessionUser(session)));
    }

    private Map<String, Object> sessionUser(HttpSession session) {
        Map<String, Object> user = new LinkedHashMap<>();
        user.put("role", role(session));
        user.put("username", username(session));
        if ("STUDENT".equals(role(session))) {
            user.put("studentName", session.getAttribute("studentName"));
            user.put("usn", session.getAttribute("usn"));
            user.put("department", session.getAttribute("department"));
        }
        return user;
    }

    @GetMapping("/me")
    public ResponseEntity<?> me(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (!loggedIn(session)) return error(HttpStatus.UNAUTHORIZED, "Please log in.");
        return ResponseEntity.ok(result("Current user", sessionUser(session)));
    }

    @PostMapping("/logout")
    public ResponseEntity<?> logout(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (session != null) session.invalidate();
        return ResponseEntity.ok(result("Logged out", null));
    }

    @GetMapping("/departments")
    public ResponseEntity<?> departments() {
        return ResponseEntity.ok(result("Departments", DEPARTMENTS));
    }

    /* =========================================================
       CERTIFICATE REQUESTS
       ========================================================= */

    @GetMapping("/certificates")
    public ResponseEntity<?> getCertificates(
            @RequestParam(required = false) String department,
            HttpServletRequest request) {

        HttpSession session = request.getSession(false);
        if (!loggedIn(session)) return error(HttpStatus.UNAUTHORIZED, "Please log in.");

        String role = role(session);
        boolean filterByDepartment = department != null && !department.isBlank();

        if (filterByDepartment && !isDepartment(department)) {
            return error(HttpStatus.BAD_REQUEST, "Invalid department filter.");
        }

        StringBuilder sql = new StringBuilder("SELECT * FROM requests WHERE 1 = 1");
        List<Object> args = new ArrayList<>();

        if ("STUDENT".equals(role)) {
            sql.append(" AND student_username = ?");
            args.add(studentKey(session));
        } else if (filterByDepartment) {
            sql.append(" AND department = ?");
            args.add(department);
        }
        sql.append(" ORDER BY id DESC");

        List<Map<String, Object>> rows =
                jdbc.query(sql.toString(), (rs, i) -> mapRequest(rs), args.toArray());

        return ResponseEntity.ok(result("Certificate requests", attach(rows)));
    }

    @PostMapping("/certificates")
    public synchronized ResponseEntity<?> createCertificate(
            @RequestBody Map<String, String> body,
            HttpServletRequest request) {

        HttpSession session = request.getSession(false);
        if (!"STUDENT".equals(role(session))) {
            return error(HttpStatus.FORBIDDEN, "Only students can submit requests.");
        }

        String type = str(body, "certificateType");
        String purpose = str(body, "purpose");
        if (type.isBlank() || purpose.isBlank()) {
            return error(HttpStatus.BAD_REQUEST, "Enter certificate type and purpose.");
        }
        if (type.length() > 100 || purpose.length() > 1000) {
            return error(HttpStatus.BAD_REQUEST, "Certificate type or purpose is too long.");
        }

        LocalDate expected;
        try {
            String date = str(body, "expectedDate");
            expected = date.isBlank() ? LocalDate.now().plusDays(5) : LocalDate.parse(date);
        } catch (Exception e) {
            return error(HttpStatus.BAD_REQUEST, "Enter a valid expected date.");
        }
        if (expected.isBefore(LocalDate.now())) {
            return error(HttpStatus.BAD_REQUEST, "The required date cannot be in the past.");
        }

        // Prevent duplicate submissions of the same certificate
        Integer open = jdbc.queryForObject(
                "SELECT COUNT(*) FROM requests WHERE student_username = ? AND certificate_type = ? "
                        + "AND status NOT IN ('Ready for Collection', 'Collected', 'Rejected')",
                Integer.class, studentKey(session), type);
        if (open != null && open > 0) {
            return error(HttpStatus.CONFLICT,
                    "You already have an active request for this certificate.");
        }

        String now = LocalDateTime.now().toString();
        String actor = username(session);

        Long id = tx.execute(status -> {
            KeyHolder keys = new GeneratedKeyHolder();
            jdbc.update(con -> {
                var ps = con.prepareStatement(
                        "INSERT INTO requests(student_username, student_name, usn, department, "
                                + "certificate_type, purpose, status, submitted_at, original_expected_date, "
                                + "expected_date, delay_reason, office_remarks, updated_at, updated_by) "
                                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        new String[]{"ID"});
                ps.setString(1, studentKey(session));
                ps.setString(2, (String) session.getAttribute("studentName"));
                ps.setString(3, (String) session.getAttribute("usn"));
                ps.setString(4, (String) session.getAttribute("department"));
                ps.setString(5, type);
                ps.setString(6, purpose);
                ps.setString(7, "Submitted");
                ps.setString(8, now);
                ps.setString(9, expected.toString());
                ps.setString(10, expected.toString());
                ps.setString(11, "");
                ps.setString(12, "");
                ps.setString(13, now);
                ps.setString(14, actor);
                return ps;
            }, keys);
            long newId = Objects.requireNonNull(keys.getKey()).longValue();
            addHistory(newId, "Submitted", "Request submitted", actor);
            return newId;
        });

        return ResponseEntity.status(HttpStatus.CREATED)
                .body(result("Certificate request submitted", findRequest(id)));
    }

    @PatchMapping("/certificates/{id}")
    public synchronized ResponseEntity<?> updateCertificate(
            @PathVariable long id,
            @RequestBody Map<String, String> body,
            HttpServletRequest request) {

        HttpSession session = request.getSession(false);
        if (!loggedIn(session)) return error(HttpStatus.UNAUTHORIZED, "Please log in.");
        if (!"OFFICE".equals(role(session))) {
            return error(HttpStatus.FORBIDDEN, "Only office staff can update requests.");
        }

        Map<String, Object> current = findRequest(id);
        if (current == null) return error(HttpStatus.NOT_FOUND, "Request not found.");

        // The office must be working in the same department as the request
        String department = str(body, "department");
        if (department.isBlank()) {
            return error(HttpStatus.BAD_REQUEST, "Select a department first.");
        }
        if (!department.equals(current.get("department"))) {
            return error(HttpStatus.FORBIDDEN, "This request belongs to another department.");
        }

        String oldStatus = (String) current.get("status");
        String newStatus = str(body, "status");
        if (!STATUSES.contains(newStatus)) {
            return error(HttpStatus.BAD_REQUEST, "Choose a valid status.");
        }

        String delayReason = str(body, "delayReason");
        String remarks = str(body, "officeRemarks");
        String expectedText = str(body, "expectedDate");

        if ("Delayed".equals(newStatus) && delayReason.isBlank()) {
            return error(HttpStatus.BAD_REQUEST, "Enter the reason for the delay.");
        }
        if (!"Delayed".equals(newStatus)) delayReason = "";
        if (delayReason.length() > 500 || remarks.length() > 1000) {
            return error(HttpStatus.BAD_REQUEST, "Delay reason or remarks is too long.");
        }

        String expected = (String) current.get("expectedDate");
        if (!expectedText.isBlank()) {
            try {
                expected = LocalDate.parse(expectedText).toString();
            } catch (Exception e) {
                return error(HttpStatus.BAD_REQUEST, "Enter a valid expected date.");
            }
        }

        List<String> changes = new ArrayList<>();
        if (!newStatus.equals(oldStatus)) {
            changes.add("Status changed from " + oldStatus + " to " + newStatus);
        }
        if (!delayReason.equals(Objects.toString(current.get("delayReason"), ""))) {
            changes.add(delayReason.isBlank() ? "Delay reason removed" : "Delay reason: " + delayReason);
        }
        if (!remarks.equals(Objects.toString(current.get("officeRemarks"), ""))) {
            changes.add(remarks.isBlank() ? "Office remarks removed" : "Office remarks: " + remarks);
        }
        if (!expected.equals(current.get("expectedDate"))) {
            changes.add("Expected date changed to " + expected);
        }

        if (changes.isEmpty()) {
            return ResponseEntity.ok(result("No changes to save.", current));
        }

        final String finalReason = delayReason;
        final String finalExpected = expected;
        final String note = String.join("; ", changes);
        final String actor = username(session);

        tx.executeWithoutResult(status -> {
            jdbc.update(
                    "UPDATE requests SET status = ?, delay_reason = ?, office_remarks = ?, "
                            + "expected_date = ?, updated_at = ?, updated_by = ? WHERE id = ?",
                    newStatus, finalReason, remarks, finalExpected,
                    LocalDateTime.now().toString(), actor, id);
            addHistory(id, newStatus, note, actor);
        });

        return ResponseEntity.ok(result("Certificate request updated", findRequest(id)));
    }

    /* =========================================================
       PDF UPLOAD AND DOWNLOAD
       ========================================================= */

    @PostMapping("/certificates/{id}/documents/{kind}")
    public synchronized ResponseEntity<?> uploadDocument(
            @PathVariable long id,
            @PathVariable String kind,
            @RequestParam("file") MultipartFile file,
            HttpServletRequest request) {

        HttpSession session = request.getSession(false);
        if (!loggedIn(session)) return error(HttpStatus.UNAUTHORIZED, "Please log in.");
        if (!isKind(kind)) return error(HttpStatus.BAD_REQUEST, "Unknown document type.");

        Map<String, Object> current = findRequest(id);
        if (current == null) return error(HttpStatus.NOT_FOUND, "Request not found.");

        boolean supporting = "supporting".equals(kind);

        if (supporting) {
            if (!"STUDENT".equals(role(session))
                    || !studentKey(session).equals(current.get("student"))) {
                return error(HttpStatus.FORBIDDEN, "You can only upload to your own requests.");
            }
            if (CLOSED_STATUSES.contains((String) current.get("status"))) {
                return error(HttpStatus.BAD_REQUEST, "This request is closed.");
            }
        } else if (!"OFFICE".equals(role(session))) {
            return error(HttpStatus.FORBIDDEN, "Only office staff can upload issued certificates.");
        }

        if (file.isEmpty()) return error(HttpStatus.BAD_REQUEST, "Choose a PDF file.");
        if (file.getSize() > MAX_PDF_BYTES) {
            return error(HttpStatus.BAD_REQUEST, "The PDF must be 10 MB or smaller.");
        }

        String original = file.getOriginalFilename() == null ? "document.pdf" : file.getOriginalFilename();
        if (!original.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
            return error(HttpStatus.BAD_REQUEST, "Only PDF files are allowed.");
        }

        String displayName = original.substring(
                Math.max(original.lastIndexOf('/'), original.lastIndexOf('\\')) + 1);
        displayName = limit(displayName.replaceAll("[^A-Za-z0-9._ -]", "_"), 100);

        String storedName = id + "-" + kind + "-" + UUID.randomUUID() + ".pdf";
        Path target = uploadDir.resolve(storedName).normalize();
        if (!target.startsWith(uploadDir)) {
            return error(HttpStatus.BAD_REQUEST, "Invalid file name.");
        }

        final String column = supporting ? "supporting" : "issued";

        try {
            // A real PDF always starts with "%PDF-"
            try (InputStream in = file.getInputStream()) {
                String magic = new String(in.readNBytes(5), StandardCharsets.US_ASCII);
                if (!"%PDF-".equals(magic)) {
                    return error(HttpStatus.BAD_REQUEST, "That file is not a valid PDF.");
                }
            }

            List<String> oldPaths = jdbc.query(
                    "SELECT " + column + "_path FROM requests WHERE id = ?",
                    (rs, i) -> rs.getString(1), id);
            String oldPath = oldPaths.isEmpty() ? null : oldPaths.get(0);

            file.transferTo(target);

            final String finalName = displayName;
            final String actor = username(session);
            final String statusNow = (String) current.get("status");
            final String note = (supporting ? "Supporting document " : "Issued certificate ")
                    + (oldPath == null ? "uploaded: " : "replaced: ") + displayName;

            try {
                tx.executeWithoutResult(status -> {
                    jdbc.update(
                            "UPDATE requests SET " + column + "_path = ?, " + column + "_name = ?, "
                                    + "updated_at = ?, updated_by = ? WHERE id = ?",
                            storedName, finalName, LocalDateTime.now().toString(), actor, id);
                    addHistory(id, statusNow, note, actor);
                });
            } catch (RuntimeException e) {
                Files.deleteIfExists(target);
                throw e;
            }

            if (oldPath != null) {
                Path oldFile = uploadDir.resolve(oldPath).normalize();
                if (oldFile.startsWith(uploadDir)) Files.deleteIfExists(oldFile);
            }
        } catch (IOException e) {
            return error(HttpStatus.INTERNAL_SERVER_ERROR, "The PDF could not be saved. Try again.");
        }

        return ResponseEntity.ok(result("PDF uploaded successfully", findRequest(id)));
    }

    @GetMapping("/certificates/{id}/documents/{kind}")
    public ResponseEntity<?> downloadDocument(
            @PathVariable long id,
            @PathVariable String kind,
            HttpServletRequest request) {

        HttpSession session = request.getSession(false);
        if (!loggedIn(session)) return error(HttpStatus.UNAUTHORIZED, "Please log in.");
        if (!isKind(kind)) return error(HttpStatus.BAD_REQUEST, "Unknown document type.");

        Map<String, Object> current = findRequest(id);
        if (current == null) return error(HttpStatus.NOT_FOUND, "Request not found.");

        // Students can only open their own documents
        if ("STUDENT".equals(role(session))
                && !studentKey(session).equals(current.get("student"))) {
            return error(HttpStatus.FORBIDDEN, "You can only open your own documents.");
        }

        List<String[]> rows = jdbc.query(
                "SELECT " + kind + "_path, " + kind + "_name FROM requests WHERE id = ?",
                (rs, i) -> new String[]{rs.getString(1), rs.getString(2)}, id);

        if (rows.isEmpty() || rows.get(0)[0] == null) {
            return error(HttpStatus.NOT_FOUND, "No PDF has been uploaded yet.");
        }

        Path file = uploadDir.resolve(rows.get(0)[0]).normalize();
        if (!file.startsWith(uploadDir) || !Files.isRegularFile(file)) {
            return error(HttpStatus.NOT_FOUND, "The PDF file could not be found.");
        }

        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.inline()
                                .filename(rows.get(0)[1], StandardCharsets.UTF_8).build().toString())
                .header("X-Content-Type-Options", "nosniff")
                .body(new FileSystemResource(file));
    }

    /* =========================================================
       ISSUE REPORTING
       ========================================================= */

    @PostMapping("/certificates/{id}/issues")
    public ResponseEntity<?> reportIssue(
            @PathVariable long id,
            @RequestBody Map<String, String> body,
            HttpServletRequest request) {

        HttpSession session = request.getSession(false);
        if (!"STUDENT".equals(role(session))) {
            return error(HttpStatus.FORBIDDEN, "Only students can report issues.");
        }

        Map<String, Object> current = findRequest(id);
        if (current == null || !studentKey(session).equals(current.get("student"))) {
            return error(HttpStatus.NOT_FOUND, "Request not found.");
        }

        String message = str(body, "message");
        if (message.isBlank()) return error(HttpStatus.BAD_REQUEST, "Describe the problem.");
        if (message.length() > 1000) {
            return error(HttpStatus.BAD_REQUEST, "Keep the message under 1000 characters.");
        }

        final String actor = username(session);
        final String statusNow = (String) current.get("status");

        tx.executeWithoutResult(status -> {
            jdbc.update(
                    "INSERT INTO issues(request_id, student_username, message, created_at) VALUES (?,?,?,?)",
                    id, studentKey(session), message, LocalDateTime.now().toString());
            addHistory(id, statusNow, "Issue reported by student: " + message, actor);
        });

        return ResponseEntity.ok(result("Issue reported to the office", findRequest(id)));
    }

    /* =========================================================
       ADMINISTRATOR
       ========================================================= */

    @GetMapping("/admin/summary")
    public ResponseEntity<?> adminSummary(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (!loggedIn(session)) return error(HttpStatus.UNAUTHORIZED, "Please log in.");
        if (!"ADMIN".equals(role(session))) {
            return error(HttpStatus.FORBIDDEN, "Administrator access only.");
        }

        List<String[]> rows = jdbc.query(
                "SELECT department, status, expected_date FROM requests",
                (rs, i) -> new String[]{rs.getString(1), rs.getString(2), rs.getString(3)});

        int total = 0, pending = 0, completed = 0, delayed = 0, rejected = 0, overdue = 0;
        Map<String, int[]> perDepartment = new LinkedHashMap<>();
        for (String d : DEPARTMENTS) perDepartment.put(d, new int[5]);

        String today = LocalDate.now().toString();

        for (String[] row : rows) {
            String department = row[0], status = row[1], expected = row[2];
            int[] d = perDepartment.computeIfAbsent(department, k -> new int[5]);

            total++;
            d[0]++;
            if (PENDING_STATUSES.contains(status)) { pending++; d[1]++; }
            if ("Delayed".equals(status)) { delayed++; d[2]++; }
            if (COMPLETED_STATUSES.contains(status)) { completed++; d[3]++; }
            if ("Rejected".equals(status)) { rejected++; d[4]++; }
            if (expected != null && expected.compareTo(today) < 0
                    && !CLOSED_STATUSES.contains(status)) {
                overdue++;
            }
        }

        List<Map<String, Object>> byDepartment = new ArrayList<>();
        perDepartment.forEach((name, d) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("department", name);
            m.put("total", d[0]);
            m.put("pending", d[1]);
            m.put("delayed", d[2]);
            m.put("completed", d[3]);
            m.put("rejected", d[4]);
            byDepartment.add(m);
        });

        Integer students = jdbc.queryForObject("SELECT COUNT(*) FROM students", Integer.class);

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("total", total);
        summary.put("pending", pending);
        summary.put("completed", completed);
        summary.put("delayed", delayed);
        summary.put("rejected", rejected);
        summary.put("overdue", overdue);
        summary.put("registeredStudents", students == null ? 0 : students);
        summary.put("byDepartment", byDepartment);

        return ResponseEntity.ok(result("Summary", summary));
    }

    @GetMapping("/admin/students")
    public ResponseEntity<?> adminStudents(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (!loggedIn(session)) return error(HttpStatus.UNAUTHORIZED, "Please log in.");
        if (!"ADMIN".equals(role(session))) {
            return error(HttpStatus.FORBIDDEN, "Administrator access only.");
        }

        List<Map<String, Object>> students = jdbc.query(
                "SELECT s.student_name, s.usn, s.department, s.username, s.created_at, "
                        + "(SELECT COUNT(*) FROM requests r WHERE r.student_username = s.username_key) AS request_count "
                        + "FROM students s ORDER BY s.student_name",
                (rs, i) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("studentName", rs.getString("student_name"));
                    m.put("usn", rs.getString("usn"));
                    m.put("department", rs.getString("department"));
                    m.put("username", rs.getString("username"));
                    m.put("createdAt", rs.getString("created_at"));
                    m.put("requestCount", rs.getInt("request_count"));
                    return m;
                });

        return ResponseEntity.ok(result("Registered students", students));
    }

    /* =========================================================
       ERROR MESSAGES FOR UPLOAD SIZE AND BAD JSON
       ========================================================= */

    @RestControllerAdvice
    public static class ApiErrors {

        @ExceptionHandler(MaxUploadSizeExceededException.class)
        public ResponseEntity<Map<String, Object>> tooLarge() {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("message", "The PDF must be 10 MB or smaller.");
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(body);
        }

        @ExceptionHandler(HttpMessageNotReadableException.class)
        public ResponseEntity<Map<String, Object>> badJson() {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("message", "The request could not be read. Check the values and try again.");
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
        }
    }
}