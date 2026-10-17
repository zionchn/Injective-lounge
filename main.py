import os
import random
import re
from datetime import datetime, timezone
from urllib.parse import urlparse
from flask import Flask, render_template, request, redirect, url_for, flash, abort
from flask_bootstrap import Bootstrap5
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.exc import IntegrityError
import requests


from dotenv import load_dotenv
load_dotenv()


# Setting up the webhook to help transfer data from the db to a goodle sheet
SHEET_WEBHOOK_URL = os.environ.get("SHEET_WEBHOOK_URL")
SHEET_TOKEN = os.environ.get("SHEET_TOKEN")


def send_to_sheet(sub, address):
    if not SHEET_WEBHOOK_URL:
        return
    try:
        requests.post(SHEET_WEBHOOK_URL, json={
            "token": SHEET_TOKEN,
            "created_at": sub.created_at.strftime("%Y-%m-%d %H:%M"),
            "address": address,
            "topic": sub.topic or "",
            "content_url": sub.content_url,
        }, timeout=5)
    except requests.RequestException as e:
        app.logger.warning("Sheet sync failed: %s", e)


# Set up flask web server
app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ["SECRET_KEY"]

# SQLAlchemy needs postgresql://
db_url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or "sqlite:///lounge.db"

# Force the psycopg2 driver for Postgres URLs
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql+psycopg2://", 1)
elif db_url.startswith("postgresql://"):
    db_url = db_url.replace("postgresql://", "postgresql+psycopg2://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}

bootstrap = Bootstrap5(app)
db = SQLAlchemy(app)

# ---------- Model ----------
class Wallet(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    address = db.Column(db.String(42), unique=True, nullable=False, index=True)
    topic = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))


# Second model in case of dual submissions
class Submission(db.Model):
    __table_args__ = (
        db.UniqueConstraint("wallet_id", "content_url", name="uq_wallet_content"),
    )

    id = db.Column(db.Integer, primary_key=True)
    wallet_id = db.Column(db.Integer, db.ForeignKey("wallet.id"), nullable=False, index=True)
    address = db.Column(db.String(42), nullable=False, index=True)
    topic = db.Column(db.String(255), nullable=True)
    content_url = db.Column(db.String(500), nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    wallet = db.relationship("Wallet", backref="submissions")



# Topic loader code
TOPICS_FILE = os.path.join(app.root_path, "topics.txt")


def pick_random_topic():
    with open(TOPICS_FILE, encoding="utf-8") as f:
        topics = [line.strip() for line in f if line.strip()]
    if not topics:
        raise RuntimeError("topics.txt is empty")
    return random.choice(topics)


with app.app_context():
    db.create_all()


# ---------- inj address validation (format + bech32 checksum) ----------
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]


def _polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= GEN[i]
    return chk


def is_valid_inj(address: str) -> bool:
    if not re.fullmatch(r"inj1[a-z0-9]{38}", address):
        return False
    if any(c not in CHARSET for c in address[4:]):
        return False
    hrp = "inj"
    expanded = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    data = [CHARSET.index(c) for c in address[4:]]
    return _polymod(expanded + data) == 1



# Set up the home page route
@app.route("/", methods=["GET", "POST"])
def home():
    if request.method == "POST":
        address = request.form.get("wallet", "").strip().lower()

        if not is_valid_inj(address):
            flash("That doesn't look like a valid Injective address (inj1...).", "danger")
            return redirect(url_for("home"))

        wallet = Wallet.query.filter_by(address=address).first()

        if wallet is None:
            try:
                db.session.add(Wallet(address=address, topic=pick_random_topic()))
                db.session.commit()
            except IntegrityError:          # two requests raced, address already saved
                db.session.rollback()
        elif wallet.topic is None:          # older rows saved before topics existed
            wallet.topic = pick_random_topic()
            db.session.commit()

        return redirect(url_for("wallet_page", address=address))

    now = datetime.now()
    return render_template("index.html", current_date=now.strftime("%Y"))

# Submit content based on wallet address route
@app.route("/wallet/<address>")
def wallet_page(address):
    address = address.lower()
    if not is_valid_inj(address):
        abort(404)
    wallet = Wallet.query.filter_by(address=address).first_or_404()
    return render_template("wallet.html", wallet=wallet)



# For returning users
@app.route("/lookup", methods=["POST"])
def lookup():
    address = request.form.get("wallet", "").strip().lower()

    if not is_valid_inj(address):
        flash("That doesn't look like a valid Injective address (inj1...).", "danger")
        return redirect(url_for("home"))

    wallet = Wallet.query.filter_by(address=address).first()
    if wallet is None:
        flash("No topic found for this address yet. Click ‘Get my topic' to get one.", "warning")
        return redirect(url_for("home"))

    return redirect(url_for("wallet_page", address=address))


from urllib.parse import urlparse


@app.route("/wallet/<address>/submit", methods=["POST"])
def submit_content(address):
    address = address.lower()
    if not is_valid_inj(address):
        abort(404)
    wallet = Wallet.query.filter_by(address=address).first_or_404()

    url = request.form.get("content_url", "").strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or len(url) > 500:
        flash("Please enter a valid link (https://...).", "danger")
        return redirect(url_for("wallet_page", address=address))

    try:
        sub = Submission(wallet_id=wallet.id, address=wallet.address,
                         topic=wallet.topic, content_url=url)
        db.session.add(sub)
        db.session.commit()
        send_to_sheet(sub, wallet.address)
        flash("Content submitted!", "success")
    except IntegrityError:
        db.session.rollback()
        flash("You've already submitted that link.", "warning")

    return redirect(url_for("wallet_page", address=address))




# Run app
if __name__ == '__main__':
    app.run(debug=True, port=5001)