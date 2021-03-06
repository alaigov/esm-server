'use strict';

var _ = require('lodash'),
  path = require('path'),
  mongoose = require('mongoose'),
  User = mongoose.model('User'),
  Role = mongoose.model('_Role');

var Invitation = require(path.resolve('./modules/invitations/server/controllers/invitation.controller'));

// ensure that we have come through Siteminder...
var parseSm = function (req) {
  return new Promise(function (fulfill, reject) {
    var userGuid = req.headers.smgov_userguid;
    var userType = req.headers.smgov_usertype;
    var universalId = req.headers.sm_universalid; // if we need to add in IDIR or BCEID, get from sm_authdirname

    if (!_.isEmpty(process.env.ALLOW_SITEMINDER_OVERRIDE) && process.env.ALLOW_SITEMINDER_OVERRIDE === 'true') {
      userGuid = userGuid || req.params.userguid || req.query.smgov_userguid;
      userType = userType || req.params.usertype || req.query.smgov_usertype;
      universalId = universalId || req.params.sm_universalid || req.query.sm_universalid;
    }

    if (userGuid) {
      fulfill({userGuid: userGuid, userType: userType, universalId: universalId});
    } else {
      reject(new Error('parseSm: Could not find user information from Siteminder'));
    }
  });
};

var findUserByGuid = function (userGuid) {
  return new Promise(function (fulfill, reject) {
    User.findOne({
      userGuid: userGuid.toLowerCase()
    }).populate('org').exec(function (error, user) {
      if (error) {
        reject(new Error(error));
      } else if (!user) {
        reject(new Error('findUserByGuid: User not found for Siteminder headers.'));
      } else {
        fulfill(user);
      }
    });
  });
};

var checkUsers = function (sm, user, inviteUser) {
  return new Promise(function (fulfill, reject) {
    if (!user && !inviteUser) {
      reject(new Error('No users found to sign in'));
    }
    else if (!user && inviteUser) {
      if (!_.isEmpty(inviteUser.userGuid) && (sm.userGuid !== inviteUser.userGuid)) {
        // auto-assigned guid - we can carry on in this case...
        if (inviteUser.userGuid.lastIndexOf("esm-", 0) === 0) {
          fulfill(inviteUser);
        } else {
          reject(new Error('Invitation user does not match Signed in user.'));
        }
      } else {
        // carry on with the invitation's user, will need to set siteminder fields...
        fulfill(inviteUser);
      }
    } else if (user && inviteUser) {
      if (!_.isEmpty(user.userGuid) && user.userGuid === inviteUser.userGuid) {
        // all good, invited user matches and has been signed in before...
        fulfill(user);
      } else {
        // we've got a problem here...
        // siteminder headers loaded a user that doesn't match up with our invite user
        reject(new Error('Signed in user does not match Invitation user.'));
      }
    }
  });
};

var updateRolesUsername = function(sm, user) {
  // a user is invited and possibly assigned roles to their generated username.
  // so let's update the generated username to the Siteminder username...
  if (sm.universalId.toLowerCase() === user.username.toLowerCase()) {
    return Promise.resolve(user);
  } else {
    var update = { user: sm.universalId.toLowerCase() }; // role schema doesn't convert to lowercase...
    var query = { user: user.username };
    return new Promise(function(fulfill, reject) {
      Role.update(query, update, {multi: true}).exec()
        .then (function () { return user; })
        .then (fulfill, reject);
    });
  }
};

var updateUserFromSiteminder = function (sm, user) {
  return new Promise(function (fulfill, reject) {
    if (_.isEmpty(user.userGuid) || _.startsWith(user.userGuid, 'esm-')) {
      // set the siteminder fields
      user.userGuid = sm.userGuid;
      user.userType = sm.userType;
      user.username = sm.universalId.toLowerCase(); // would happen automatically due to schema
      if (!_.includes(user.roles, 'user')) {
        user.roles.push('user');
      }

      user.save(function (err, u) {
        if (err) {
          reject(new Error(err));
        } else {
          fulfill(u);
        }
      });
    } else {
      fulfill(user);
    }
  });
};

var loginUser = function (req, user) {
  return new Promise(function (fulfill, reject) {
    req.logout();
    req.login(user, function (err) {
      if (err) {
        reject(new Error(err));
      } else {
        fulfill(user);
      }
    });
  });
};


exports.signIn = function (req, res) {
  var redirectPath = '/dashboard';
  var siteMinder;
  parseSm(req)
    .then(function (sm) {
      siteMinder = sm;
      return findUserByGuid(sm.userGuid);
    })
    .then(function (user) {
      return loginUser(req, user);
    })
    .then(function () {
      res.redirect(redirectPath);
    })
    .catch(function (/* err */) {
      // should we do something differently here?
      redirectPath = '/smerr';
      if (siteMinder !== undefined && siteMinder.userType !== undefined ) {
        redirectPath += '?t=' + siteMinder.userType.toLowerCase();
      }
      res.redirect(redirectPath);
    });
};

exports.acceptInvitation = function (req, res) {
  var redirectPath = '/dashboard';
  var invite, siteMinder, user;

  (new Invitation({user: req.user, context: 'application'})).acceptInvitation(req)
    .then(function (data) {
      invite = data;
      return parseSm(req);
    })
    .then(function (sm) {
      siteMinder = sm;
      return findUserByGuid(siteMinder.userGuid).catch(function () {
        // user may not have guid populated yet...
        return null;
      });
    })
    .then(function (u) {
      if (u) {
        user = u;
      }
      return checkUsers(siteMinder, user, invite.user);
    })
    .then(function (u) {
      user = u; // may come from the invite user, or the sm user...
      return updateRolesUsername(siteMinder, user);
    })
    .then(function () {
      return updateUserFromSiteminder(siteMinder, user);
    })
    .then(function () {
      return loginUser(req, user);
    })
    .then(function () {
      res.redirect(redirectPath);
    })
    .catch(function (/* err */) {
      // should we do something differently here?
      // can we examine an error type and send off a different message?
      res.redirect(redirectPath);
    });

};

exports.logHeaders = function(req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end(JSON.stringify(req.headers));
};
