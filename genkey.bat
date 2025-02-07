openssl genpkey -algorithm RSA -out key.pem
openssl req -new -x509 -key key.pem -out cert.pem
