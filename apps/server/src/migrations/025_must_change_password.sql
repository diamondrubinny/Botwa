-- After an administrator resets a password, the person must choose their own at the next sign-in.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
