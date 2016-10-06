var ERR = require('async-stacktrace');
var _ = require('lodash');
var async = require('async');
var moment = require('moment-timezone');

var logger = require('../../lib/logger');
var sqldb = require('../../lib/sqldb');
var config = require('../../lib/config');
var sqlLoader = require('../../lib/sql-loader');

var sql = sqlLoader.loadSqlEquiv(__filename);

module.exports = {
    sync: function(courseInfo, courseInstance, callback) {
        var that = module.exports;
        var assessmentIds = [];
        async.series([
            function(callback) {
                async.forEachOfSeries(courseInstance.assessmentDB, function(dbAssessment, tid, callback) {
                    logger.info('Syncing ' + tid);
                    var params = {
                        tid: tid,
                        type: dbAssessment.type,
                        number: dbAssessment.number,
                        title: dbAssessment.title,
                        config: dbAssessment.options,
                        multiple_instance: dbAssessment.options && dbAssessment.options.multipleInstance ? true : false,
                        shuffle_questions: dbAssessment.shuffleQuestions ? true : false,
                        max_score: dbAssessment.options ? dbAssessment.options.maxScore : null,
                        course_instance_id: courseInstance.courseInstanceId,
                        course_id: courseInfo.courseId,
                        set_name: dbAssessment.set,
                        text: dbAssessment.options ? dbAssessment.options.text : null,
                    };
                    sqldb.query(sql.insert_assessment, params, function(err, result) {
                        if (ERR(err, callback)) return;
                        var assessmentId = result.rows[0].id;
                        assessmentIds.push(assessmentId);
                        logger.info('Synced ' + tid + ' as assessment_id ' + assessmentId);
                        that.syncAccessRules(assessmentId, dbAssessment, function(err) {
                            if (ERR(err, callback)) return;
                            if (_(dbAssessment).has('options') && _(dbAssessment.options).has('zones')) {
                                // RetryExam, new format
                                zoneList = dbAssessment.options.zones;
                            } else if (_(dbAssessment).has('options') && _(dbAssessment.options).has('questionGroups')) {
                                // RetryExam, old format
                                zoneList = [{questions: _.flattenDeep(dbAssessment.options.questionGroups)}];
                            } else if (_(dbAssessment).has('options') && _(dbAssessment.options).has('questions')) {
                                // Homework
                                zoneList = [{questions: dbAssessment.options.questions}];
                            } else if (_(dbAssessment).has('options') && _(dbAssessment.options).has('qids')) {
                                // Basic
                                zoneList = [{questions: dbAssessment.options.qids}];
                            }
                            that.syncZones(assessmentId, zoneList, function(err) {
                                if (ERR(err, callback)) return;
                                that.syncAssessmentQuestions(assessmentId, zoneList, courseInfo, function(err) {
                                    if (ERR(err, callback)) return;
                                    callback(null);
                                });
                            });
                        });
                    });
                }, function(err) {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            },
            function(callback) {
                // soft-delete assessments from the DB that aren't on disk and are in the current course instance
                logger.info('Soft-deleting unused assessments');
                var params = {
                    course_instance_id: courseInstance.courseInstanceId,
                    keep_assessment_ids: assessmentIds,
                };
                sqldb.query(sql.soft_delete_unused_assessments, params, function(err) {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            },
            function(callback) {
                // soft-delete assessment_questions from DB that don't correspond to current assessments
                logger.info('Soft-deleting unused assessment questions');
                var params = {
                    course_instance_id: courseInstance.courseInstanceId,
                    keep_assessment_ids: assessmentIds,
                };
                sqldb.query(sql.soft_delete_unused_assessment_questions, params, function(err) {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            },
            function(callback) {
                // delete access rules from DB that don't correspond to assessments
                logger.info('Deleting unused assessment access rules');
                sqldb.query(sql.delete_unused_assessment_access_rules, [], function(err) {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            },
            function(callback) {
                // delete zones from DB that don't correspond to assessments
                logger.info('Deleting unused zones');
                sqldb.query(sql.delete_unused_zones, [], function(err) {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            },
        ], function(err) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },

    syncAccessRules: function(assessmentId, dbAssessment, callback) {
        var allowAccess = dbAssessment.allowAccess || [];
        async.forEachOfSeries(allowAccess, function(dbRule, i, callback) {
            logger.info('Syncing assessment access rule number ' + (i + 1));
            var params = {
                assessment_id: assessmentId,
                number: i + 1,
                mode: _(dbRule).has('mode') ? dbRule.mode : null,
                role: _(dbRule).has('role') ? dbRule.role : null,
                uids: _(dbRule).has('uids') ? dbRule.uids : null,
                start_date: _(dbRule).has('startDate') ? moment.tz(dbRule.startDate, config.timezone).format() : null,
                end_date: _(dbRule).has('endDate') ? moment.tz(dbRule.endDate, config.timezone).format() : null,
                credit: _(dbRule).has('credit') ? dbRule.credit : null,
            };
            sqldb.query(sql.insert_assessment_access_rule, params, function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        }, function(err) {
            if (ERR(err, callback)) return;

            // delete access rules from the DB that aren't on disk
            logger.info('Deleting unused assessment access rules for current assessment');
            var params = {
                assessment_id: assessmentId,
                last_number: allowAccess.length,
            };
            sqldb.query(sql.delete_excess_assessment_access_rules, params, function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        });
    },

    syncZones: function(assessmentId, zoneList, callback) {
        async.forEachOfSeries(zoneList, function(dbZone, i, callback) {
            logger.info('Syncing zone number ' + (i + 1));
            var params = {
                assessment_id: assessmentId,
                number: i + 1,
                title: dbZone.title,
            };
            sqldb.query(sql.insert_zone, params, function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        }, function(err) {
            if (ERR(err, callback)) return;

            // delete zones from the DB that aren't on disk
            logger.info('Deleting unused zones for current assessment');
            var params = {
                assessment_id: assessmentId,
                last_number: zoneList.length,
            };
            sqldb.query(sql.delete_excess_zones, params, function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        });
    },

    syncAssessmentQuestions: function(assessmentId, zoneList, courseInfo, callback) {
        var that = module.exports;
        var iAssessmentQuestion = 0;
        var assessmentQuestionIds = [];
        async.forEachOfSeries(zoneList, function(dbZone, iZone, callback) {
            async.forEachOfSeries(dbZone.questions, function(dbQuestion, iQuestion, callback) {
                var qids = null, maxPoints = null, pointsList = null, initPoints = null;
                if (_(dbQuestion).isString()) {
                    qids = [dbQuestion];
                    maxPoints = 1;
                } else {
                    if (_(dbQuestion).has('qids')) {
                        qids = dbQuestion.qids;
                    } else {
                        qids = [dbQuestion.qid];
                    }
                    if (_(dbQuestion).has('points')) {
                        maxPoints = _(dbQuestion.points).max();
                        pointsList = dbQuestion.points;
                    } else if (_(dbQuestion).has('initValue')) {
                        maxPoints = dbQuestion.maxScore;
                        initPoints = dbQuestion.initValue;
                    }
                }
                async.eachSeries(qids, function(qid, callback) {
                    iAssessmentQuestion++;
                    that.syncAssessmentQuestion(qid, maxPoints, pointsList, initPoints, iAssessmentQuestion, assessmentId, iZone, courseInfo, function(err, assessmentQuestionId) {
                        if (ERR(err, callback)) return;
                        assessmentQuestionIds.push(assessmentQuestionId);
                        callback(null);
                    });
                }, function(err) {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            }, function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        }, function(err) {
            if (ERR(err, callback)) return;

            // soft-delete assessment questions from the DB that aren't on disk
            logger.info('Soft-deleting unused assessment questions for current assessment');
            var params = {
                assessment_id: assessmentId,
                keep_assessment_question_ids: assessmentQuestionIds,
            };
            sqldb.query(sql.soft_delete_unused_assessment_questions_in_assessment, params, function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        });
    },

    syncAssessmentQuestion: function(qid, maxPoints, pointsList, initPoints, iAssessmentQuestion, assessmentId, iZone, courseInfo, callback) {
        var params = {
            qid: qid,
            course_id: courseInfo.courseId,
        };
        sqldb.query(sql.select_question_by_qid, params, function(err, result) {
            if (ERR(err, callback)) return;
            if (result.rowCount < 1) return callback(new Error('invalid QID: "' + qid + '"'));
            var questionId = result.rows[0].id;

            logger.info('Syncing assessment question number ' + iAssessmentQuestion + ' with QID ' + qid);
            var params = {
                number: iAssessmentQuestion,
                max_points: maxPoints,
                points_list: pointsList,
                init_points: initPoints,
                assessment_id: assessmentId,
                question_id: questionId,
                zone_number: iZone + 1,
            };
            sqldb.queryOneRow(sql.insert_assessment_question, params, function(err, result) {
                if (ERR(err, callback)) return;
                callback(null, result.rows[0].id);
            });
        });
    },
};