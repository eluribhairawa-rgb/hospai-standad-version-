-- Body temperature is recorded in degrees Celsius. Earlier readings were typed in Fahrenheit: convert the plausible
-- Fahrenheit values (86-113 F) once. Converted values are 30-45, so a re-run never touches them again.
UPDATE patient_vitals
SET temperature = ROUND((((temperature - 32) * 5.0) / 9.0)::numeric, 1)
WHERE temperature BETWEEN 86 AND 113;
