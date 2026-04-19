export interface CityData {
  name: string;
  lat: number;
  lng: number;
  info?: string;
}

export async function extractCities(prompt: string): Promise<CityData[]> {
  try {
    const response = await fetch('/api/extractCities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data = await response.json();
    return data as CityData[];
  } catch (error) {
    console.error("Error extracting cities:", error);
    return [];
  }
}

