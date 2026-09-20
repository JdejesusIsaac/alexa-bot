

---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=e9a92ed33c174867a3d0a5a13ee43d61&code_challenge=O8usdGINPydfNcMJYh_9Qi2RaTqWq_-PjqqZpI_ook0&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | ERROR at authorize: invalid_request — Client "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO" is not authorized to access resource server "http://127.0.0.1:8420". |
| code exchanged | n |
| access token iss | (opaque) |
| access token aud | (opaque) |
| tenant_id / role claims | (opaque) |
| verdict | **REJECTED** |

Detail: ERROR at authorize: invalid_request — Client "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO" is not authorized to access resource server "http://127.0.0.1:8420".
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
(opaque token — no claims to show)
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=9949839063481635cd78b4410d0f58f6&code_challenge=qyAf8uWB0VbyJb0HCEoEJ8TQ4tmizaVGf0pIEfn4-yI&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | ERROR at authorize: invalid_request — Client "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO" is not authorized to access resource server "http://127.0.0.1:8420". |
| code exchanged | n |
| access token iss | (opaque) |
| access token aud | (opaque) |
| tenant_id / role claims | (opaque) |
| verdict | **REJECTED** |

Detail: ERROR at authorize: invalid_request — Client "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO" is not authorized to access resource server "http://127.0.0.1:8420".
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
(opaque token — no claims to show)
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=444f3c077e899308ba2b3ee6a19df37c&code_challenge=MtJuxbvLpN3-rMCfEnOtYukTrJ3M1cDqgEU4p0FOSWk&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | login OK |
| code exchanged | y |
| access token iss | https://dev-zzarw43qsuyf5lm5.us.auth0.com/ |
| access token aud | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"] |
| tenant_id / role claims | tenant_id: undefined · role: undefined |
| verdict | **HONORED** |

Detail: aud = ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "google-oauth2|113993408831966520063",
  "aud": [
    "http://127.0.0.1:8420",
    "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"
  ],
  "iat": 1789653721,
  "exp": 1789740121,
  "scope": "openid",
  "azp": "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO"
}
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=aa32afea33388b9283df98fd0af85aee&code_challenge=B94QccwQpWPeU2VqvTXOkz4hf6WhQKccu6iRd4NO2tw&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | login OK |
| code exchanged | y |
| access token iss | https://dev-zzarw43qsuyf5lm5.us.auth0.com/ |
| access token aud | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"] |
| tenant_id / role claims | tenant_id: undefined · role: undefined |
| verdict | **HONORED** |

Detail: aud = ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "google-oauth2|113993408831966520063",
  "aud": [
    "http://127.0.0.1:8420",
    "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"
  ],
  "iat": 1789654501,
  "exp": 1789740901,
  "scope": "openid",
  "azp": "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO"
}
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=af7dfd223f51297ae472bdd810b0c966&code_challenge=RC0aOU5o2ICHqBNPDgRSOOrs-fp--6HBW5YkxeOtc4o&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | login OK |
| code exchanged | y |
| access token iss | https://dev-zzarw43qsuyf5lm5.us.auth0.com/ |
| access token aud | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"] |
| tenant_id / role claims | tenant_id: undefined · role: undefined |
| verdict | **HONORED** |

Detail: aud = ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "google-oauth2|113993408831966520063",
  "aud": [
    "http://127.0.0.1:8420",
    "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"
  ],
  "iat": 1789654599,
  "exp": 1789740999,
  "scope": "openid",
  "azp": "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO"
}
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=b68a26c982686b0ef5511f7411b8e2d6&code_challenge=7Ok_bdGQusUBIJi5l2_KhLSQQp5pRwDAmlDQMAbdV84&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | login OK |
| code exchanged | y |
| access token iss | https://dev-zzarw43qsuyf5lm5.us.auth0.com/ |
| access token aud | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"] |
| tenant_id / role claims | tenant_id: undefined · role: undefined |
| verdict | **HONORED** |

Detail: aud = ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "google-oauth2|113993408831966520063",
  "aud": [
    "http://127.0.0.1:8420",
    "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"
  ],
  "iat": 1789654697,
  "exp": 1789741097,
  "scope": "openid",
  "azp": "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO"
}
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=26ab7f51bcc9f64473c8edf8b4362ff6&code_challenge=E3NSszX2K8zWHmAnejStgxcR9NUdk64S3eBmPcLipJY&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | login OK |
| code exchanged | y |
| access token iss | https://dev-zzarw43qsuyf5lm5.us.auth0.com/ |
| access token aud | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"] |
| tenant_id / role claims | tenant_id: undefined · role: undefined |
| verdict | **HONORED** |

Detail: aud = ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "google-oauth2|113993408831966520063",
  "aud": [
    "http://127.0.0.1:8420",
    "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"
  ],
  "iat": 1789654968,
  "exp": 1789741368,
  "scope": "openid",
  "azp": "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO"
}
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=693e6133b0c1f8297193301539ce87b8&code_challenge=gALugK8jbyAcWT-fHqcgGOtkY8VBPrRWhaZeziGjQu8&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | login OK |
| code exchanged | y |
| access token iss | https://dev-zzarw43qsuyf5lm5.us.auth0.com/ |
| access token aud | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"] |
| tenant_id / role claims | tenant_id: undefined · role: undefined |
| verdict | **HONORED** |

Detail: aud = ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "google-oauth2|113993408831966520063",
  "aud": [
    "http://127.0.0.1:8420",
    "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"
  ],
  "iat": 1789661659,
  "exp": 1789748059,
  "scope": "openid",
  "azp": "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO"
}
```


---

### https://dev-zzarw43qsuyf5lm5.us.auth0.com — observed 2026-09-17 (mode: resource)

| Field | Value |
|---|---|
| tenant | https://dev-zzarw43qsuyf5lm5.us.auth0.com |
| authorize request | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=54b1b899a7957e45e55ef8f6dd143dc8&code_challenge=uWUjivw5VX00vbRG7WqSNloJ6kAsjE9D0by02Mvw_RU&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize | login OK |
| code exchanged | y |
| access token iss | https://dev-zzarw43qsuyf5lm5.us.auth0.com/ |
| access token aud | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"] |
| tenant_id / role claims | tenant_id: undefined · role: undefined |
| verdict | **HONORED** |

Detail: aud = ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]
Probe marker (must equal EXPECTED_AUDIENCE): http://127.0.0.1:8420

Decoded token (secrets and signatures redacted):
```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "google-oauth2|113993408831966520063",
  "aud": [
    "http://127.0.0.1:8420",
    "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"
  ],
  "iat": 1789662208,
  "exp": 1789748608,
  "scope": "openid",
  "azp": "48XaCiovaOEbuvsow4fgGvfIn1iqcgZO"
}
```
