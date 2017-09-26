DROP FUNCTION IF EXISTS errors_insert_for_assessment(bigint,text,text,boolean,jsonb,jsonb,bigint,bigint);

CREATE OR REPLACE FUNCTION
    errors_insert_for_assessment(
        assessment_id bigint,
        student_message text,
        instructor_message text,
        course_caused boolean,
        course_data jsonb,
        system_data jsonb,
        user_id bigint,
        authn_user_id bigint
    ) RETURNS void
AS $$
DECLARE
    course_id bigint;
    course_instance_id bigint;
    display_id text;
BEGIN
    SELECT
        c.id,      ci.id
    INTO
        course_id, course_instance_id
    FROM
        assessments AS a
        JOIN course_instances AS ci ON (ci.id = a.course_instance_id)
        JOIN pl_courses AS c ON (c.id = ci.course_id)
    WHERE
        a.id = assessment_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'invalid assessment_id'; END IF;

    display_id := errors_generate_display_id();

    INSERT INTO errors
        (display_id, student_message, instructor_message, course_caused, course_data, system_data, authn_user_id,
        course_id, course_instance_id, assessment_id, user_id)
    VALUES
        (display_id, student_message, instructor_message, course_caused, course_data, system_data, authn_user_id,
        course_id, course_instance_id, assessment_id, user_id);
END;
$$ LANGUAGE plpgsql VOLATILE;