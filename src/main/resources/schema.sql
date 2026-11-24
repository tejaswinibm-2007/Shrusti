CREATE TABLE IF NOT EXISTS students (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    student_name  VARCHAR(100) NOT NULL,
    usn           VARCHAR(30)  NOT NULL UNIQUE,
    department    VARCHAR(30)  NOT NULL,
    username      VARCHAR(30)  NOT NULL,
    username_key  VARCHAR(30)  NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    created_at    VARCHAR(40)  NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
    id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
    student_username       VARCHAR(30)   NOT NULL,
    student_name           VARCHAR(100)  NOT NULL,
    usn                    VARCHAR(30)   NOT NULL,
    department             VARCHAR(30)   NOT NULL,
    certificate_type       VARCHAR(100)  NOT NULL,
    purpose                VARCHAR(1000) NOT NULL,
    status                 VARCHAR(30)   NOT NULL,
    submitted_at           VARCHAR(40)   NOT NULL,
    original_expected_date VARCHAR(10)   NOT NULL,
    expected_date          VARCHAR(10)   NOT NULL,
    delay_reason           VARCHAR(500)  DEFAULT '' NOT NULL,
    office_remarks         VARCHAR(1000) DEFAULT '' NOT NULL,
    supporting_path        VARCHAR(200),
    supporting_name        VARCHAR(150),
    issued_path            VARCHAR(200),
    issued_name            VARCHAR(150),
    updated_at             VARCHAR(40)   NOT NULL,
    updated_by             VARCHAR(30)   NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_id BIGINT        NOT NULL,
    status     VARCHAR(30)   NOT NULL,
    note       VARCHAR(1500) NOT NULL,
    actor      VARCHAR(30)   NOT NULL,
    event_time VARCHAR(40)   NOT NULL,
    FOREIGN KEY (request_id) REFERENCES requests(id)
);

CREATE TABLE IF NOT EXISTS issues (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_id       BIGINT        NOT NULL,
    student_username VARCHAR(30)   NOT NULL,
    message          VARCHAR(1000) NOT NULL,
    created_at       VARCHAR(40)   NOT NULL,
    FOREIGN KEY (request_id) REFERENCES requests(id)
);

CREATE INDEX IF NOT EXISTS idx_requests_department ON requests(department);
CREATE INDEX IF NOT EXISTS idx_requests_student ON requests(student_username);
CREATE INDEX IF NOT EXISTS idx_history_request ON history(request_id);
CREATE INDEX IF NOT EXISTS idx_issues_request ON issues(request_id);