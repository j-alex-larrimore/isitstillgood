-- Make InviteToken.email optional — a generic invite link shared directly via
-- text/Instagram/Facebook/etc. (the "Share via..." button on friends.html)
-- isn't addressed to any specific recipient, unlike the existing per-email
-- invite flow.
ALTER TABLE "InviteToken" ALTER COLUMN "email" DROP NOT NULL;
