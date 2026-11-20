-- Panel sign-ins: "stay signed in on this device" sessions live longer; every session is renewed while it is used (up to an absolute cap).
ALTER TABLE sessions ADD COLUMN remember boolean NOT NULL DEFAULT false;
