-- One project charge per started character screening, including uncertain outcomes.
ALTER TABLE will_screenings ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND 3);
ALTER TABLE project_spend ADD COLUMN screening_id TEXT;
CREATE UNIQUE INDEX project_spend_screening_once ON project_spend (screening_id) WHERE screening_id IS NOT NULL;
