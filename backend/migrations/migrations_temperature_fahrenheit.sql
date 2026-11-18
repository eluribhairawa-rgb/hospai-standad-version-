-- Body temperature is recorded in degrees Fahrenheit. Earlier readings were stored in Celsius: convert the plausible
-- Celsius values (30-45 C) once. Converted values are 86-113, so a re-run never touches them again.
UPDATE patient_vitals
SET temperature = ROUND((((temperature * 9.0) / 5.0) + 32)::numeric, 1)
WHERE temperature BETWEEN 30 AND 45;
